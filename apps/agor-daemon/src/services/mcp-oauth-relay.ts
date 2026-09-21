import { createHash, createPrivateKey, type KeyObject, randomUUID } from 'node:crypto';
import {
  type AgorConfig,
  type ResolvedExternalLaunchProvider,
  resolveExternalLaunchSettings,
} from '@agor/core/config';
import {
  MCP_OAUTH_RELAY,
  type MCPOAuthRelayCallback,
  type MCPOAuthRelayPrepare,
} from '@agor/core/types';
import { safeOutboundFetch } from '@agor/core/utils/safe-outbound-fetch';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { resolveVerificationKey } from '../auth/launch-auth.js';

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

export function relayBodyHash(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** No provider exchange/refresh proxy. This client carries routing material only. */
export class MCPOAuthRelay {
  readonly origin: string;
  readonly cellId: string;
  readonly launch: ResolvedExternalLaunchProvider;
  private readonly privateKey: KeyObject;
  private readonly credentialId: string;
  private readonly keyId?: string;

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
    for (const value of [relay.cell_id, relay.credential_id])
      if (!value || value.length > 200) throw new Error('Invalid MCP relay service identity');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(relay.private_key_env))
      throw new Error('Invalid MCP relay key environment reference');
    try {
      this.privateKey = createPrivateKey(env[relay.private_key_env] ?? '');
      if (
        this.privateKey.asymmetricKeyType !== 'rsa' ||
        (this.privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error();
    } catch {
      throw new Error('MCP callback relay requires the Cell RS256 service key');
    }
    this.origin = origin.origin;
    this.cellId = relay.cell_id;
    this.credentialId = relay.credential_id;
    this.keyId = relay.key_id;
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
    if (input.redirect_uri !== this.redirectUri(input.issuer))
      throw new Error('MCP relay callback binding mismatch');
    const body = JSON.stringify(input);
    const authorization = jwt.sign(
      {
        cell_id: this.cellId,
        credential_id: this.credentialId,
        scope: MCP_OAUTH_RELAY.serviceScope,
        body_sha256: relayBodyHash(body),
      },
      this.privateKey,
      {
        algorithm: 'RS256',
        issuer: `agor-cell:${this.cellId}`,
        audience: MCP_OAUTH_RELAY.serviceAudience,
        expiresIn: 60,
        jwtid: randomUUID(),
        ...(this.keyId ? { keyid: this.keyId } : {}),
      }
    );
    try {
      const response = await safeOutboundFetch(`${this.origin}${MCP_OAUTH_RELAY.preparePath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authorization}` },
        body,
        redirect: 'error',
        timeoutMs: 10_000,
        maxResponseBytes: 8192,
      });
      if (response.status !== 201) throw new Error();
      const result = z
        .object({ start_url: z.string().url(), redirect_uri: z.string(), expires_at: z.string() })
        .strict()
        .parse(await response.json());
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
        expires > Date.now() + 600_000
      )
        throw new Error();
      return result.start_url;
    } catch {
      throw new Error(
        'Cloud callback preparation failed. Start a new connection; no direct fallback was attempted.'
      );
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
        claims.iat > now ||
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
