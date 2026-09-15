import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  MCP_OAUTH_DISABLED_FLAGS,
  MCP_OAUTH_OWNER_FIELDS,
  MCP_OAUTH_ROUTES,
  McpOAuthAckResponseSchema,
  McpOAuthCancelResponseSchema,
  McpOAuthCapabilitiesSchema,
  McpOAuthClaimSchema,
  McpOAuthCleanupResponseSchema,
  McpOAuthCloseResponseSchema,
  McpOAuthEpochSchema,
  McpOAuthExchangeRequestSchema,
  McpOAuthJwsHeaderSchema,
  McpOAuthOperationResponseSchema,
  McpOAuthOwnerSchema,
  McpOAuthPrepareRequestSchema,
  McpOAuthProfileProjectionSchema,
  McpOAuthReceiptClaimsSchema,
  McpOAuthRefreshRequestSchema,
  McpOAuthReturnTicketResponseSchema,
  McpOAuthSenderClaimsSchema,
  McpOAuthTokensSchema,
  McpOAuthUseClaimsSchema,
  mcpOAuthClaimIsLive,
  mcpOAuthLengthPrefix,
  mcpOAuthOwnerBytes,
  mcpOAuthParseJson,
  mcpOAuthSha256,
  mcpOAuthTokensDigest,
} from '../../types/mcp-managed-oauth-contract';
import vectors from './__fixtures__/managed-v1/hash-vectors.json';
import invalid from './__fixtures__/managed-v1/invalid.json';
import manifest from './__fixtures__/managed-v1/manifest.json';
import projectionFixtures from './__fixtures__/managed-v1/projection-results.json';
import projectionManifest from './__fixtures__/managed-v1/projection-results.manifest.json';
import signatures from './__fixtures__/managed-v1/signature-vectors.json';
import sourcePin from './__fixtures__/managed-v1/source-pin.json';
import valid from './__fixtures__/managed-v1/valid.json';

const schemas: Record<string, ZodType> = {
  owner: McpOAuthOwnerSchema,
  claim: McpOAuthClaimSchema,
  prepare: McpOAuthPrepareRequestSchema,
  exchange: McpOAuthExchangeRequestSchema,
  refresh: McpOAuthRefreshRequestSchema,
  sender_claims: McpOAuthSenderClaimsSchema,
  use_claims: McpOAuthUseClaimsSchema,
  receipt_claims: McpOAuthReceiptClaimsSchema,
  succeeded: McpOAuthOperationResponseSchema,
};
describe('managed OAuth D0 canonical fixture contract', () => {
  it('pins the exact producer source bytes and manifest, not just self-consistent fixtures', () => {
    expect(
      mcpOAuthSha256(
        readFileSync(new URL('../../types/mcp-managed-oauth-contract.ts', import.meta.url))
      )
    ).toBe(sourcePin.source_sha256);
    expect(
      mcpOAuthSha256(
        readFileSync(new URL('./__fixtures__/managed-v1/manifest.json', import.meta.url))
      )
    ).toBe(sourcePin.manifest_sha256);
    expect(sourcePin.commit).toMatch(/^[a-f0-9]{40}$/);
  });
  for (const [name, fixture] of Object.entries(valid))
    it(`accepts ${name}`, () => expect(schemas[name].safeParse(fixture).success).toBe(true));
  for (const [index, fixture] of invalid.entries())
    it(`rejects invalid ${index} ${fixture.schema}`, () =>
      expect(schemas[fixture.schema].safeParse(fixture.value).success).toBe(false));
  it('pins every fixture by exact UTF-8 hash', () => {
    for (const [name, expected] of Object.entries(manifest.files))
      expect(
        mcpOAuthSha256(readFileSync(new URL(`./__fixtures__/managed-v1/${name}`, import.meta.url)))
      ).toBe(expected);
  });
  it('uses unambiguous U32BE UTF-8 components and canonical owner order', () => {
    for (const vector of vectors.length_prefix) {
      expect(Buffer.from(mcpOAuthLengthPrefix(vector.parts)).toString('hex')).toBe(vector.hex);
      expect(mcpOAuthSha256(mcpOAuthLengthPrefix(vector.parts))).toBe(vector.sha256);
    }
    expect(MCP_OAUTH_OWNER_FIELDS).toEqual(vectors.owner_fields);
    expect(mcpOAuthSha256(mcpOAuthOwnerBytes(McpOAuthOwnerSchema.parse(valid.owner)))).toBe(
      vectors.owner_sha256
    );
    expect(mcpOAuthTokensDigest(McpOAuthTokensSchema.parse(valid.succeeded.tokens))).toBe(
      vectors.tokens_digest
    );
    expect(mcpOAuthSha256('')).toBe(vectors.empty_body_sha256);
    expect(mcpOAuthSha256('agor-mcp-managed-v1\0transaction_alpha')).toBe(
      vectors.synthetic_state_sha256
    );
  });
  it('validates independent public-key signatures, types and exact claims', () => {
    for (const [token, expected, typ] of [
      [signatures.use_authorization, valid.use_claims, 'mcp-oauth-use+jwt'],
      [signatures.signed_receipt, valid.receipt_claims, 'mcp-oauth-receipt+jwt'],
    ] as const) {
      const [header, payload, signature] = token.split('.');
      expect(
        McpOAuthJwsHeaderSchema.parse(JSON.parse(Buffer.from(header, 'base64url').toString())).typ
      ).toBe(typ);
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual(expected);
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}`),
          createPublicKey(signatures.public_key_pem),
          Buffer.from(signature, 'base64url')
        )
      ).toBe(true);
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}X`),
          createPublicKey(signatures.public_key_pem),
          Buffer.from(signature, 'base64url')
        )
      ).toBe(false);
    }
    expect(valid.receipt_claims.use_authorization_digest).toBe(
      mcpOAuthSha256(signatures.use_authorization)
    );
  });
  it('never rounds epochs or accepts alternate encodings', () => {
    for (const value of ['-1', '1e2', '1.0', '01', '', 'NaN', ' 1', '+1', 1, 9007199254740992])
      expect(McpOAuthEpochSchema.safeParse(value).success).toBe(false);
    expect(McpOAuthEpochSchema.parse('9007199254740993')).toBe('9007199254740993');
  });
  it('enforces original hard cutoff without a sweeper and dispatch headroom', () => {
    const claim = McpOAuthClaimSchema.parse(valid.refresh.claim);
    expect(mcpOAuthClaimIsLive(claim, claim.deadline_at - 1)).toBe(true);
    expect(mcpOAuthClaimIsLive(claim, claim.deadline_at)).toBe(false);
    expect(mcpOAuthClaimIsLive(claim, claim.deadline_at - 45000, true)).toBe(true);
    expect(mcpOAuthClaimIsLive(claim, claim.deadline_at - 44999, true)).toBe(false);
    expect(mcpOAuthClaimIsLive(claim, claim.claimed_at - 1)).toBe(false);
  });
  it('rejects unknown fields at every security-bearing object', () => {
    for (const [name, fixture] of Object.entries(valid))
      expect(schemas[name].safeParse({ ...fixture, unknown_security_field: true }).success).toBe(
        false
      );
    expect(
      McpOAuthExchangeRequestSchema.safeParse({
        ...valid.exchange,
        owner: { ...valid.owner, secret_version: '1' },
      }).success
    ).toBe(false);
  });
  it('rejects duplicate/escaped JSON keys, trailing data and resource abuse', () => {
    for (const raw of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '{"x":{"a":1,"a":2}}',
      '{"a":1,}',
      '[1,]',
      '1 2',
      '[01]',
      '[NaN]',
      '[Infinity]',
      ' '.repeat(65537),
      '['.repeat(18) + '0' + ']'.repeat(18),
    ])
      expect(() => mcpOAuthParseJson(raw)).toThrow();
    expect(mcpOAuthParseJson('{"x":["a",null,true,false,-1.5e2]}')).toEqual({
      x: ['a', null, true, false, -150],
    });
  });
  it('defines no standalone renewal and enables nothing by default', () => {
    expect(Object.values(MCP_OAUTH_DISABLED_FLAGS).every((value) => value === false)).toBe(true);
    expect(Object.values(MCP_OAUTH_ROUTES).some((route) => /renew/.test(route))).toBe(false);
  });
});

describe('paired immutable provider projection and responses', () => {
  const parsers: Record<string, ZodType> = {
    profile: McpOAuthProfileProjectionSchema,
    public_profile: McpOAuthProfileProjectionSchema,
    multiple_metadata_profile: McpOAuthProfileProjectionSchema,
    capabilities: McpOAuthCapabilitiesSchema,
    prepare: McpOAuthPrepareRequestSchema,
    ack: McpOAuthAckResponseSchema,
    cancel: McpOAuthCancelResponseSchema,
    close: McpOAuthCloseResponseSchema,
    cleanup: McpOAuthCleanupResponseSchema,
    cleanup_uncertain: McpOAuthCleanupResponseSchema,
    cleanup_in_progress: McpOAuthCleanupResponseSchema,
    return_ticket: McpOAuthReturnTicketResponseSchema,
  };
  it('pins additive fixtures without rewriting original signatures', () => {
    expect(
      mcpOAuthSha256(
        readFileSync(
          new URL('./__fixtures__/managed-v1/projection-results.manifest.json', import.meta.url)
        )
      )
    ).toBe(sourcePin.projection_manifest_sha256);
    for (const [name, hash] of Object.entries(projectionManifest.files))
      expect(
        mcpOAuthSha256(readFileSync(new URL(`./__fixtures__/managed-v1/${name}`, import.meta.url)))
      ).toBe(hash);
  });
  for (const [name, value] of Object.entries(projectionFixtures.valid))
    it(`accepts producer ${name}`, () =>
      expect(parsers[name]!.safeParse(value).success).toBe(true));
  for (const [index, fixture] of projectionFixtures.invalid.entries())
    it(`rejects producer negative ${index}`, () =>
      expect(parsers[fixture.schema]!.safeParse(fixture.value).success).toBe(false));
});
