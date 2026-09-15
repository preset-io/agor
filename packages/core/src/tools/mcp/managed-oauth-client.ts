/** Cell-to-broker transport. This module never contacts a provider or retries a dispatch. */
import { type KeyObject, randomUUID, sign, verify } from 'node:crypto';
import type { ZodType } from 'zod';
import {
  MCP_OAUTH_JWS_TYPES,
  MCP_OAUTH_LIMITS,
  MCP_OAUTH_ROUTES,
  type McpOAuthClaim,
  type McpOAuthExchangeRequest,
  McpOAuthExchangeRequestSchema,
  McpOAuthIdSchema,
  McpOAuthJwsHeaderSchema,
  type McpOAuthOperationResponse,
  McpOAuthOperationResponseSchema,
  McpOAuthOriginSchema,
  type McpOAuthOwner,
  McpOAuthReceiptClaimsSchema,
  McpOAuthReceiptRequestSchema,
  type McpOAuthRefreshRequest,
  McpOAuthRefreshRequestSchema,
  McpOAuthSenderClaimsSchema,
  McpOAuthSignedArtifactSchema,
  McpOAuthSucceededSchema,
  McpOAuthUseClaimsSchema,
  mcpOAuthClaimIsLive,
  mcpOAuthEgressAudience,
  mcpOAuthOwnerBytes,
  mcpOAuthParseJson,
  mcpOAuthReceiptAudience,
  mcpOAuthSenderAudience,
  mcpOAuthSha256,
  mcpOAuthTokensDigest,
} from '../../types/mcp-managed-oauth-contract';
import { safeOutboundFetch } from '../../utils/safe-outbound-fetch';

export class ManagedMCPOAuthProtocolError extends Error {
  constructor(readonly category: 'unavailable' | 'invalid_response' | 'claim_expired') {
    // Never include the underlying network/schema error: it can contain credentials.
    super(`Managed MCP OAuth ${category}`);
    this.name = 'ManagedMCPOAuthProtocolError';
  }
}

function assertRsaKey(key: KeyObject, type: 'private' | 'public'): void {
  if (
    key.type !== type ||
    key.asymmetricKeyType !== 'rsa' ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new ManagedMCPOAuthProtocolError('unavailable');
  }
}

/** Cryptography only: each consumer must also check audience, issuer, clock and live authority. */
export function verifyManagedOAuthArtifact<T>(
  artifact: string,
  kind: 'receipt' | 'use',
  schema: ZodType<T>,
  keys: ReadonlyMap<string, KeyObject>
): T {
  try {
    McpOAuthSignedArtifactSchema.parse(artifact);
    const [headerPart, payloadPart, signaturePart] = artifact.split('.');
    for (const part of [headerPart, payloadPart, signaturePart]) {
      if (Buffer.from(part, 'base64url').toString('base64url') !== part) throw new Error();
    }
    const header = McpOAuthJwsHeaderSchema.parse(
      mcpOAuthParseJson(Buffer.from(headerPart, 'base64url').toString('utf8'))
    );
    if (header.typ !== MCP_OAUTH_JWS_TYPES[kind]) throw new Error();
    const key = keys.get(header.kid);
    if (!key) throw new Error();
    assertRsaKey(key, 'public');
    if (
      !verify(
        'RSA-SHA256',
        Buffer.from(`${headerPart}.${payloadPart}`),
        key,
        Buffer.from(signaturePart, 'base64url')
      )
    )
      throw new Error();
    return schema.parse(mcpOAuthParseJson(Buffer.from(payloadPart, 'base64url').toString('utf8')));
  } catch {
    throw new ManagedMCPOAuthProtocolError('invalid_response');
  }
}

export interface ManagedOAuthExpectedOperation {
  owner: McpOAuthOwner;
  claim: McpOAuthClaim;
  operationId: string;
  sequence: string;
  handle?: string;
  handleEpoch?: string;
}

function sameOwner(a: McpOAuthOwner, b: McpOAuthOwner): boolean {
  return Buffer.from(mcpOAuthOwnerBytes(a)).equals(Buffer.from(mcpOAuthOwnerBytes(b)));
}

function sameClaim(a: McpOAuthClaim, b: McpOAuthClaim): boolean {
  return (
    a.kind === b.kind &&
    a.claim_id === b.claim_id &&
    a.claimed_at === b.claimed_at &&
    a.deadline_at === b.deadline_at &&
    a.refresh_generation === b.refresh_generation &&
    a.refresh_success_generation === b.refresh_success_generation
  );
}

export function validateManagedOAuthOutcome(
  response: unknown,
  expected: ManagedOAuthExpectedOperation,
  now: number
): McpOAuthOperationResponse {
  try {
    const parsed = McpOAuthOperationResponseSchema.parse(response);
    if (
      !sameOwner(parsed.owner, expected.owner) ||
      !sameClaim(parsed.claim, expected.claim) ||
      parsed.operation_id !== expected.operationId ||
      parsed.sequence !== expected.sequence
    )
      throw new Error();
    if (!mcpOAuthClaimIsLive(expected.claim, now)) {
      throw new ManagedMCPOAuthProtocolError('claim_expired');
    }
    return parsed;
  } catch (error) {
    if (error instanceof ManagedMCPOAuthProtocolError) throw error;
    throw new ManagedMCPOAuthProtocolError('invalid_response');
  }
}

/** Verify both independently signed artifacts and every returned token/owner/claim field. */
export function validateManagedOAuthSuccess(
  response: unknown,
  expected: ManagedOAuthExpectedOperation,
  policy: { issuer: string; keys: ReadonlyMap<string, KeyObject>; now: number }
) {
  try {
    const result = McpOAuthSucceededSchema.parse(
      validateManagedOAuthOutcome(response, expected, policy.now)
    );
    const receipt = verifyManagedOAuthArtifact(
      result.signed_receipt,
      'receipt',
      McpOAuthReceiptClaimsSchema,
      policy.keys
    );
    const use = verifyManagedOAuthArtifact(
      result.use_authorization,
      'use',
      McpOAuthUseClaimsSchema,
      policy.keys
    );
    for (const artifact of [receipt, use]) {
      if (
        artifact.iss !== policy.issuer ||
        !sameOwner(artifact.owner, expected.owner) ||
        !sameClaim(artifact.claim, expected.claim) ||
        artifact.operation_id !== expected.operationId ||
        artifact.receipt_id !== result.receipt_id ||
        artifact.handle !== result.handle ||
        artifact.handle_epoch !== result.handle_epoch ||
        artifact.sequence !== expected.sequence ||
        artifact.next_sequence !== result.next_sequence ||
        artifact.issued_at !== result.issued_at ||
        artifact.token_digest !== mcpOAuthSha256(result.tokens.access_token) ||
        artifact.issued_at > policy.now ||
        artifact.expires_at <= policy.now ||
        (expected.handle !== undefined && artifact.handle !== expected.handle) ||
        (expected.handleEpoch !== undefined && artifact.handle_epoch !== expected.handleEpoch)
      )
        throw new Error();
    }
    if (
      receipt.aud !== mcpOAuthReceiptAudience(expected.owner) ||
      use.aud !== mcpOAuthEgressAudience(expected.owner) ||
      receipt.tokens_digest !== mcpOAuthTokensDigest(result.tokens) ||
      receipt.use_authorization_digest !== mcpOAuthSha256(result.use_authorization) ||
      receipt.expires_at !== result.expires_at ||
      use.token_expires_at !== result.tokens.expires_at
    )
      throw new Error();
    return { result, receipt, use };
  } catch (error) {
    if (error instanceof ManagedMCPOAuthProtocolError) throw error;
    throw new ManagedMCPOAuthProtocolError('invalid_response');
  }
}

export interface ManagedOAuthSenderConfiguration {
  origin: string;
  environment: McpOAuthOwner['environment'];
  region: McpOAuthOwner['residency_region'];
  cellId: string;
  credentialId: string;
  keyId: string;
  privateKey: KeyObject;
  /** Trusted deployment time source, not a request field. */
  now: () => number;
}

type Operation = keyof Pick<
  typeof MCP_OAUTH_ROUTES,
  | 'capabilities'
  | 'authority'
  | 'prepare'
  | 'activate'
  | 'status'
  | 'exchange'
  | 'cancel'
  | 'refresh'
  | 'close'
  | 'cleanup'
  | 'receipt'
  | 'ack'
  | 'invalidations'
  | 'return_ticket'
>;

export class ManagedMCPOAuthClient {
  constructor(private readonly config: ManagedOAuthSenderConfiguration) {
    McpOAuthOriginSchema.parse(config.origin);
    assertRsaKey(config.privateKey, 'private');
    for (const id of [config.cellId, config.credentialId, config.keyId]) McpOAuthIdSchema.parse(id);
  }

  /** Exactly one physical request. Uncertain failures are NOT a no-dispatch journal receipt. */
  async request<T>(options: {
    operation: Operation;
    id?: string;
    body: { operation_id: string } & Record<string, unknown>;
    schema: ZodType<T>;
    assertCurrent: () => void | Promise<void>;
    recovery?: boolean;
    /** Remaining enclosing deadline; can only shorten the protocol budget. */
    timeoutMs?: number;
  }): Promise<T> {
    try {
      let path: string = MCP_OAUTH_ROUTES[options.operation];
      if (path.includes(':id')) {
        // Grant handles satisfy this subset too. No URL parser normalization at this boundary.
        const id = McpOAuthIdSchema.parse(options.id);
        path = path.replace(':id', id);
      } else if (options.id !== undefined) throw new Error();
      const target = `${this.config.origin}${path}`;
      const body = JSON.stringify(options.body);
      if (Buffer.byteLength(body) > MCP_OAUTH_LIMITS.request_bytes) throw new Error();
      const now = Math.floor(this.config.now() / 1000);
      const claims = McpOAuthSenderClaimsSchema.parse({
        iss: this.config.cellId,
        sub: this.config.cellId,
        aud: mcpOAuthSenderAudience(this.config.environment, this.config.region),
        iat: now,
        exp: now + MCP_OAUTH_LIMITS.sender_lifetime_seconds,
        jti: randomUUID(),
        credential_id: this.config.credentialId,
        cell_id: this.config.cellId,
        environment: this.config.environment,
        residency_region: this.config.region,
        scope: `mcp_oauth:${options.operation}`,
        http_method: 'POST',
        target_uri: target,
        body_sha256: mcpOAuthSha256(body),
        operation_id: options.body.operation_id,
      });
      const header = McpOAuthJwsHeaderSchema.parse({
        alg: 'RS256',
        kid: this.config.keyId,
        typ: MCP_OAUTH_JWS_TYPES.sender,
      });
      const unsigned = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
      const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), this.config.privateKey).toString('base64url')}`;
      const response = await safeOutboundFetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
        body,
        redirect: 'error',
        maxRedirects: 0,
        maxResponseBytes: MCP_OAUTH_LIMITS.response_bytes,
        timeoutMs: Math.min(
          options.recovery
            ? MCP_OAUTH_LIMITS.recovery_timeout_ms
            : MCP_OAUTH_LIMITS.cell_timeout_ms,
          options.timeoutMs ?? MCP_OAUTH_LIMITS.cell_timeout_ms
        ),
        assertCurrent: options.assertCurrent,
      });
      if (
        !response.ok ||
        response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
      ) {
        throw new Error();
      }
      return options.schema.parse(
        mcpOAuthParseJson(await response.text(), MCP_OAUTH_LIMITS.response_bytes)
      );
    } catch {
      // No cause, provider body, URL, token or arbitrary schema diagnostic escapes.
      throw new ManagedMCPOAuthProtocolError('unavailable');
    }
  }
}

/**
 * A broker journal outcome, not a direct OAuth error. In particular app-client
 * configuration failure must never be translated into InvalidGrantError.
 */
export class ManagedMCPOAuthOperationError extends Error {
  constructor(readonly outcome: Exclude<McpOAuthOperationResponse, { status: 'succeeded' }>) {
    super(`Managed MCP OAuth ${outcome.status}`);
    this.name = 'ManagedMCPOAuthOperationError';
  }
}

/**
 * Operation dependency used beneath the existing cell claim/CAS owner. The
 * caller durably binds operation_id before invoking this function. Recovery
 * reads only that operation's journal; it never sends the code/token again.
 */
export async function executeManagedOAuthOperation(options: {
  client: ManagedMCPOAuthClient;
  request: McpOAuthExchangeRequest | McpOAuthRefreshRequest;
  sequence: string;
  issuer: string;
  keys: ReadonlyMap<string, KeyObject>;
  now: () => number;
  assertCurrent: () => void | Promise<void>;
}) {
  const refresh = 'refresh_token' in options.request;
  const request = refresh
    ? McpOAuthRefreshRequestSchema.parse(options.request)
    : McpOAuthExchangeRequestSchema.parse(options.request);
  const expected: ManagedOAuthExpectedOperation = {
    owner: request.owner,
    claim: request.claim,
    operationId: request.operation_id,
    sequence: options.sequence,
    ...('handle' in request ? { handle: request.handle, handleEpoch: request.handle_epoch } : {}),
  };
  const assertLive = async (forDispatch: boolean) => {
    await options.assertCurrent();
    if (!mcpOAuthClaimIsLive(request.claim, options.now(), forDispatch)) {
      throw new ManagedMCPOAuthProtocolError('claim_expired');
    }
  };
  await assertLive(true);
  let response: McpOAuthOperationResponse | undefined;
  try {
    response = await options.client.request({
      operation: refresh ? 'refresh' : 'exchange',
      id: 'handle' in request ? request.handle : request.transaction_id,
      body: request,
      schema: McpOAuthOperationResponseSchema,
      assertCurrent: () => assertLive(true),
    });
  } catch {
    // Network and HTTP failures do not establish whether provider dispatch occurred.
  }
  if (!response || response.status === 'in_progress') {
    // At most 10 seconds total recovery, still inside the ORIGINAL local claim.
    const recoveryDeadline = Math.min(
      request.claim.deadline_at,
      options.now() + MCP_OAUTH_LIMITS.recovery_timeout_ms
    );
    const monotonicDeadline = performance.now() + Math.max(0, recoveryDeadline - options.now());
    do {
      await assertLive(false);
      const remaining = Math.floor(
        Math.min(recoveryDeadline - options.now(), monotonicDeadline - performance.now())
      );
      if (remaining <= 0) throw new ManagedMCPOAuthProtocolError('unavailable');
      response = await options.client.request({
        operation: 'receipt',
        id: request.operation_id,
        recovery: true,
        timeoutMs: remaining,
        body: McpOAuthReceiptRequestSchema.parse({
          protocol_version: 1,
          operation_id: randomUUID(),
          owner: request.owner,
          target_operation_id: request.operation_id,
          claim: request.claim,
        }),
        schema: McpOAuthOperationResponseSchema,
        assertCurrent: () => assertLive(false),
      });
      if (response.status !== 'in_progress') break;
      if (options.now() >= recoveryDeadline || performance.now() >= monotonicDeadline)
        throw new ManagedMCPOAuthProtocolError('unavailable');
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (options.now() < recoveryDeadline && performance.now() < monotonicDeadline);
  }
  if (!response) throw new ManagedMCPOAuthProtocolError('unavailable');
  await assertLive(false);
  const outcome = validateManagedOAuthOutcome(response, expected, options.now());
  if (outcome.status !== 'succeeded') throw new ManagedMCPOAuthOperationError(outcome);
  return validateManagedOAuthSuccess(outcome, expected, {
    issuer: options.issuer,
    keys: options.keys,
    now: options.now(),
  });
}
