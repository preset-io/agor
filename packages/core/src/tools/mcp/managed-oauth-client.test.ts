import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  McpOAuthClaimSchema,
  McpOAuthOwnerSchema,
  McpOAuthUseClaimsSchema,
  mcpOAuthSha256,
} from '../../types/mcp-managed-oauth-contract';
import signatures from './__fixtures__/managed-v1/signature-vectors.json';
import valid from './__fixtures__/managed-v1/valid.json';
import {
  ManagedMCPOAuthClient,
  validateManagedOAuthSuccess,
  verifyManagedOAuthArtifact,
} from './managed-oauth-client';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/safe-outbound-fetch', () => ({ safeOutboundFetch: fetchMock }));
afterEach(() => vi.resetAllMocks());
const expected = {
  owner: McpOAuthOwnerSchema.parse(valid.owner),
  claim: McpOAuthClaimSchema.parse(valid.claim),
  operationId: valid.succeeded.operation_id,
  sequence: valid.succeeded.sequence,
};
const policy = {
  issuer: valid.receipt_claims.iss,
  keys: new Map([['fixture-key-not-live', createPublicKey(signatures.public_key_pem)]]),
  now: valid.succeeded.issued_at,
};

describe('managed OAuth signed token receipt acceptance', () => {
  it('accepts independently produced Cloud fixture and full token commitment', () => {
    const result = validateManagedOAuthSuccess(valid.succeeded, expected, policy);
    expect(result.use).toEqual(valid.use_claims);
    expect(result.receipt).toEqual(valid.receipt_claims);
  });
  it('rejects every swapped owner component and exact original claim field', () => {
    for (const key of Object.keys(expected.owner) as (keyof typeof expected.owner)[]) {
      expect(() =>
        validateManagedOAuthSuccess(
          valid.succeeded,
          {
            ...expected,
            owner: { ...expected.owner, [key]: 'other' },
          },
          policy
        )
      ).toThrow();
    }
    for (const key of [
      'claim_id',
      'claimed_at',
      'deadline_at',
      'refresh_generation',
      'refresh_success_generation',
    ] as const) {
      expect(() =>
        validateManagedOAuthSuccess(
          valid.succeeded,
          {
            ...expected,
            claim: { ...expected.claim, [key]: key.endsWith('_at') ? 1 : 'other' },
          },
          policy
        )
      ).toThrow();
    }
  });
  it('rejects unsigned result drift, alternate audience/issuer, unknown key and exact expiry', () => {
    for (const changes of [
      { handle: 'X'.repeat(43) },
      { handle_epoch: '2' },
      { next_sequence: '2' },
      { receipt_id: 'another_receipt' },
      { expires_at: valid.succeeded.expires_at + 1 },
      { tokens: { ...valid.succeeded.tokens, access_token: 'SENTINEL_OTHER_ACCESS' } },
      { tokens: { ...valid.succeeded.tokens, refresh_token: 'SENTINEL_OTHER_REFRESH' } },
      { signed_receipt: signatures.use_authorization },
    ])
      expect(() =>
        validateManagedOAuthSuccess({ ...valid.succeeded, ...changes }, expected, policy)
      ).toThrow();
    expect(() =>
      validateManagedOAuthSuccess(valid.succeeded, expected, {
        ...policy,
        issuer: 'https://other.test/',
      })
    ).toThrow();
    expect(() =>
      validateManagedOAuthSuccess(valid.succeeded, expected, { ...policy, keys: new Map() })
    ).toThrow();
    expect(() =>
      validateManagedOAuthSuccess(valid.succeeded, expected, {
        ...policy,
        now: expected.claim.deadline_at,
      })
    ).toThrow();
    expect(() =>
      verifyManagedOAuthArtifact(
        signatures.use_authorization,
        'receipt',
        McpOAuthUseClaimsSchema,
        policy.keys
      )
    ).toThrow();
  });
});

describe('cell sender has no executor-token or retry fallback', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const client = () =>
    new ManagedMCPOAuthClient({
      origin: 'https://oauth.staging.example.test',
      environment: 'staging',
      region: 'us-west-2',
      cellId: 'cell_alpha',
      credentialId: 'credential_alpha',
      keyId: 'key_alpha',
      privateKey: pair.privateKey,
      now: () => 1_800_000_000_000,
    });
  it('binds the raw UTF-8 body, exact target, operation, dedicated scope and audience', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    );
    await client().request({
      operation: 'status',
      id: 'transaction_alpha',
      body: {
        operation_id: 'op_alpha',
        protocol_version: 1,
      },
      schema: z.strictObject({ ok: z.literal(true) }),
      assertCurrent: () => {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    const [header, payload, signature] = init.headers.authorization.slice(7).split('.');
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        pair.publicKey,
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true);
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      kid: 'key_alpha',
      typ: 'mcp-oauth-sender+jwt',
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      iss: 'cell_alpha',
      sub: 'cell_alpha',
      aud: 'agor-cloud:mcp-oauth:v1:staging:us-west-2',
      target_uri: target,
      http_method: 'POST',
      body_sha256: mcpOAuthSha256(init.body),
      scope: 'mcp_oauth:status',
      operation_id: 'op_alpha',
      credential_id: 'credential_alpha',
      iat: 1_800_000_000,
      exp: 1_800_000_060,
    });
    expect(init).toMatchObject({ redirect: 'error', maxRedirects: 0, timeoutMs: 45_000 });
  });
  it('never retries a timeout or exposes its secret-bearing cause', async () => {
    fetchMock.mockRejectedValue(new Error('SENTINEL_ACCESS_SENTINEL_REFRESH'));
    await expect(
      client().request({
        operation: 'refresh',
        id: 'H'.repeat(43),
        body: { operation_id: 'op' },
        schema: z.unknown(),
        assertCurrent: () => {},
      })
    ).rejects.toThrow('Managed MCP OAuth unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects duplicate response keys and unsafe route identifiers without fallback', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"ok":true,"ok":false}', { headers: { 'content-type': 'application/json' } })
    );
    await expect(
      client().request({
        operation: 'status',
        id: 'valid',
        body: { operation_id: 'op' },
        schema: z.unknown(),
        assertCurrent: () => {},
      })
    ).rejects.toThrow();
    fetchMock.mockClear();
    await expect(
      client().request({
        operation: 'status',
        id: '../other',
        body: { operation_id: 'op' },
        schema: z.unknown(),
        assertCurrent: () => {},
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
