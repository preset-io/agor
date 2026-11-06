import {
  type AgorConfig,
  type ResolvedExternalLaunchProvider,
  resolveExternalLaunchSettings,
} from '@agor/core/config';
import {
  asMCPExternalError,
  type MCPExternalErrorCategory,
  type MCPExternalErrorReason,
} from '@agor/core/mcp';
import {
  MCP_OAUTH_RELAY,
  type MCPOAuthRelayCallback,
  type MCPOAuthRelayPrepare,
} from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { resolveVerificationKey } from '../auth/launch-auth.js';
import {
  type CloudRuntimeCredential,
  loadCloudRuntimeCredential,
  readBoundedText,
  sha256Hex,
  signCloudRuntimeAssertion,
} from '../utils/cloud-runtime-credential.js';

// Ordinary bounded clock skew, not a longer assertion lifetime or a retry permit.
const CLOCK_SKEW_SECONDS = 30;
const PREPARE_MAX_RESPONSE_BYTES = 8192;

const id = z.string().min(1).max(200);
const callbackSchema = z
  .object({
    workspace_id: id,
    cloud_user_id: id,
    runtime_user_id: id,
    server_id: id,
    attempt_id: id,
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    issuer: z.string().url(),
    redirect_uri: z.string().url(),
    code: z.string().min(1).max(8192).optional(),
    error: z.string().min(1).max(256).optional(),
    iss: z.string().url().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.code) !== Boolean(value.error));

export const relayBodyHash = sha256Hex;

/** No provider exchange/refresh proxy. This client carries routing material only. */
export class MCPOAuthRelay {
  readonly origin: string;
  readonly cellId: string;
  readonly launch: ResolvedExternalLaunchProvider;
  private readonly credential: CloudRuntimeCredential;

  constructor(config: AgorConfig, env: NodeJS.ProcessEnv = process.env) {
    const relay = config.mcp_oauth_relay;
    const launch = resolveExternalLaunchSettings(config);
    if (
      !relay ||
      launch.error ||
      !launch.settings.enabled ||
      !launch.settings.issuer ||
      (!launch.settings.jwksUrl && !launch.settings.publicKey) ||
      launch.settings.devSharedSecret
    ) {
      throw new Error('MCP callback relay requires the configured asymmetric Cloud launch trust');
    }
    const origin = new URL(relay.callback_origin);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== relay.callback_origin ||
      origin.username ||
      origin.password
    ) {
      throw new Error('MCP callback relay requires an exact trusted HTTPS origin');
    }
    // The Cell's existing runtime service credential, provisioned by Cloud.
    this.credential = loadCloudRuntimeCredential(env);
    this.origin = origin.origin;
    this.cellId = this.credential.cellId;
    this.launch = launch.settings;
  }

  redirectUri(issuer: string): string {
    const parsed = new URL(issuer);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search
    )
      throw new Error('Invalid MCP relay issuer');
    return `${this.origin}${MCP_OAUTH_RELAY.callbackPrefix}${relayBodyHash(issuer)}`;
  }

  async prepare(input: MCPOAuthRelayPrepare): Promise<string> {
    // Retain only closed phase/status/code metadata. Do not retain the original
    // exception/cause, response prose, prepared URL, state or signed credential.
    // The owning OAuth Start handler logs the sanitized failure once.
    let reason: MCPExternalErrorReason = 'oauth_relay_prepare_binding_failed';
    let category: MCPExternalErrorCategory | undefined = 'configuration_required';
    try {
      if (input.redirect_uri !== this.redirectUri(input.issuer))
        throw new Error('MCP relay callback binding mismatch');
      reason = 'oauth_relay_prepare_signing_failed';
      const body = JSON.stringify(input);
      const authorization = signCloudRuntimeAssertion(this.credential, {
        scope: MCP_OAUTH_RELAY.serviceScope,
        body,
      });
      reason = 'oauth_relay_prepare_transport_failed';
      category = undefined;
      // Plain fetch, not safeOutboundFetch: the destination is the trusted,
      // operator-configured callback origin (validated above), and private-network
      // control planes (e.g. SDX's internal ALB) resolve it to RFC1918 addresses
      // that the user-input SSRF guard rightly refuses. Launch JWKS does the same.
      const response = await fetch(`${this.origin}${MCP_OAUTH_RELAY.preparePath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authorization}` },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 201) {
        reason = 'oauth_relay_prepare_http_rejected';
        // Response bodies (including proxy/Cloud rejection prose) are not needed.
        if (response.status < 300) category = 'invalid_response';
        throw Object.assign(new Error('Cloud preparation rejected'), { status: response.status });
      }
      reason = 'oauth_relay_prepare_invalid_response';
      category = 'invalid_response';
      const result = z
        .object({ start_url: z.string().url(), redirect_uri: z.string(), expires_at: z.string() })
        .strict()
        .parse(JSON.parse(await readBoundedText(response, PREPARE_MAX_RESPONSE_BYTES)));
      const start = new URL(result.start_url);
      const expires = Date.parse(result.expires_at);
      if (
        start.origin !== this.origin ||
        start.username ||
        start.password ||
        start.hash ||
        result.redirect_uri !== input.redirect_uri ||
        !Number.isFinite(expires) ||
        expires <= Date.now() ||
        expires > Date.now() + 600_000 + CLOCK_SKEW_SECONDS * 1000
      )
        throw new Error();
      return result.start_url;
    } catch (error) {
      throw asMCPExternalError(error, { stage: 'oauth', reason, category });
    }
  }

  async verifyDelivery(
    body: Buffer,
    authorization: string | undefined
  ): Promise<MCPOAuthRelayCallback> {
    try {
      if (
        body.length > 16384 ||
        !authorization?.startsWith('Bearer ') ||
        authorization.length > 16384
      )
        throw new Error();
      const token = authorization.slice(7);
      const decoded = jwt.decode(token, { complete: true });
      if (decoded?.header.alg !== 'RS256') throw new Error();
      const key = await resolveVerificationKey(decoded.header, this.launch);
      const claims = jwt.verify(token, key, {
        algorithms: ['RS256'],
        issuer: this.launch.issuer,
        audience: `agor-cell:${this.cellId}:mcp-oauth-relay`,
        clockTolerance: CLOCK_SKEW_SECONDS,
      }) as jwt.JwtPayload;
      const data = callbackSchema.parse(JSON.parse(body.toString('utf8')));
      const now = Math.floor(Date.now() / 1000);
      if (
        claims.purpose !== MCP_OAUTH_RELAY.callbackPurpose ||
        claims.cell_id !== this.cellId ||
        claims.sub !== `user:${data.cloud_user_id}` ||
        claims.workspace_id !== data.workspace_id ||
        claims.tenant_id !== data.workspace_id ||
        claims.body_sha256 !== relayBodyHash(body) ||
        typeof claims.jti !== 'string' ||
        !claims.jti ||
        typeof claims.iat !== 'number' ||
        typeof claims.exp !== 'number' ||
        claims.iat > now + CLOCK_SKEW_SECONDS ||
        claims.exp - claims.iat > 30 ||
        claims.exp <= claims.iat ||
        data.redirect_uri !== this.redirectUri(data.issuer) ||
        (data.iss !== undefined && data.iss !== data.issuer)
      )
        throw new Error();
      return data;
    } catch {
      throw new Error('Invalid MCP callback delivery');
    }
  }
}
