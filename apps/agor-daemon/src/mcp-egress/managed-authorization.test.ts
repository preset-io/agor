import { createPublicKey } from 'node:crypto';
import { MCP_OAUTH_OWNER_FIELDS, McpOAuthUseClaimsSchema } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import projectionFixtures from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/projection-results.json';
import signatures from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/signature-vectors.json';
import valid from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/valid.json';
import { verifyManagedUseAuthorization } from './managed-authorization.js';
import { ManagedAuthorityClock } from './managed-clock.js';

function fixture() {
  const claims = McpOAuthUseClaimsSchema.parse(valid.use_claims);
  let utc = claims.issued_at;
  const clock = new ManagedAuthorityClock(
    () => ({
      utcMs: utc,
      monotonicMs: utc - claims.issued_at,
      combinedUncertaintyMs: 5_000,
      safe: true,
    }),
    () => utc - claims.issued_at
  );
  const kid = JSON.parse(
    Buffer.from(signatures.use_authorization.split('.')[0]!, 'base64url').toString()
  ).kid as string;
  const input: Parameters<typeof verifyManagedUseAuthorization>[0] = {
    signedAuthorization: signatures.use_authorization,
    authorization: `Bearer ${valid.succeeded.tokens.access_token}`,
    expected: claims,
    currentOwner: { ...claims.owner },
    issuer: claims.iss,
    keys: new Map([[kid, createPublicKey(signatures.public_key_pem)]]),
    clock,
    capabilities: {
      protocol_version: 1,
      binding_version: 1,
      enforcement_version: 1,
      available: true,
      environment: claims.owner.environment,
      residency_region: claims.owner.residency_region,
      recovery_incarnation: claims.owner.recovery_incarnation,
      profile_versions: [
        {
          ...projectionFixtures.valid.profile,
          profile_id: claims.owner.profile_id,
          profile_version: claims.owner.profile_version,
          catalog_digest: claims.owner.catalog_digest,
        },
      ],
      flags: {
        managed_mcp_oauth_v1: true,
        new_starts: true,
        exchange: true,
        refresh: true,
        use_authorization_issuance: true,
        revocation: true,
      },
    },
    wholeCellEligible: true,
    enforced: true,
    assertNotInvalidated: vi.fn(async () => {}),
  };
  return {
    input,
    setTime: (value: number) => {
      utc = value;
    },
  };
}

describe('worker co-issued managed use authorization', () => {
  it('verifies the pinned Cloud signature vector and exact actual outbound token', async () => {
    const { input } = fixture();
    await expect(verifyManagedUseAuthorization(input)).resolves.toEqual(input.expected);
    expect(input.assertNotInvalidated).toHaveBeenCalledExactlyOnceWith(input.expected);
    await expect(
      verifyManagedUseAuthorization({ ...input, authorization: 'Bearer wrong-fake-token' })
    ).rejects.toMatchObject({ code: 'managed_authority_invalid' });
  });

  it.each(MCP_OAUTH_OWNER_FIELDS)('denies cross-owner/epoch substitution of %s', async (field) => {
    const { input } = fixture();
    const owner = { ...input.currentOwner };
    Object.assign(owner, { [field]: `${owner[field]}different` });
    await expect(
      verifyManagedUseAuthorization({ ...input, currentOwner: owner })
    ).rejects.toMatchObject({ code: 'managed_authority_invalid' });
    expect(input.assertNotInvalidated).not.toHaveBeenCalled();
  });

  it('does not extend use across lost notifications, minute/hour outages, receipt replay or restart', async () => {
    const { input, setTime } = fixture();
    setTime(input.expected.issued_at + 60_000);
    await expect(verifyManagedUseAuthorization(input)).resolves.toBeDefined();
    setTime(input.expected.expires_at - 5_001);
    await expect(verifyManagedUseAuthorization(input)).resolves.toBeDefined();
    setTime(input.expected.expires_at - 5_000);
    await expect(verifyManagedUseAuthorization(input)).rejects.toMatchObject({
      code: 'managed_authority_expired',
    });
    setTime(input.expected.issued_at + 61 * 60_000);
    await expect(verifyManagedUseAuthorization(input)).rejects.toMatchObject({
      code: 'managed_authority_expired',
    });
    await expect(
      verifyManagedUseAuthorization({ ...input, clock: new ManagedAuthorityClock(() => null) })
    ).rejects.toMatchObject({ code: 'managed_clock_unsafe' });
    const restarted = fixture();
    restarted.setTime(input.expected.expires_at);
    await expect(verifyManagedUseAuthorization(restarted.input)).rejects.toMatchObject({
      code: 'managed_authority_expired',
    });
  });

  it('honors known invalidation immediately and checks expiry again after the durable read', async () => {
    const { input, setTime } = fixture();
    await expect(
      verifyManagedUseAuthorization({
        ...input,
        assertNotInvalidated: async () => {
          throw new Error('closed');
        },
      })
    ).rejects.toMatchObject({ code: 'managed_authority_unavailable' });
    await expect(
      verifyManagedUseAuthorization({
        ...input,
        assertNotInvalidated: async () => {
          setTime(input.expected.expires_at);
        },
      })
    ).rejects.toMatchObject({ code: 'managed_authority_expired' });
  });

  it('denies old/off/observe replicas, missing capability, receipt-as-permit, unknown key and changed original claim', async () => {
    const { input } = fixture();
    for (const change of [
      { enforced: false },
      { wholeCellEligible: false },
      { capabilities: undefined },
      { keys: new Map() },
      { signedAuthorization: signatures.signed_receipt },
      { issuer: 'https://other-worker.example.test/' },
      { expected: { ...input.expected, receipt_id: 'other-receipt' } },
      { expected: { ...input.expected, expires_at: input.expected.expires_at + 1 } },
    ])
      await expect(verifyManagedUseAuthorization({ ...input, ...change })).rejects.toThrow();
  });
});
