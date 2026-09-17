import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  MCP_OAUTH_JWS_TYPES,
  MCP_OAUTH_LIMITS,
  MCP_OAUTH_OWNER_FIELDS,
  McpOAuthUseClaimsSchema,
} from '@agor/core/types';
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
  it.each([120_000, 2 * 60 * 60_000])(
    'uses the original minimum deadline for a %i ms provider token, including after restart',
    async (tokenLifetime) => {
      const { input, setTime } = fixture();
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const original = McpOAuthUseClaimsSchema.parse({
        ...input.expected,
        token_expires_at: input.expected.issued_at + tokenLifetime,
        expires_at: input.expected.issued_at + Math.min(tokenLifetime, MCP_OAUTH_LIMITS.use_ms),
      });
      const encode = (claims: typeof original) => {
        const payload = [
          { alg: 'RS256', typ: MCP_OAUTH_JWS_TYPES.use, kid: 'synthetic-deadline' },
          claims,
        ]
          .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
          .join('.');
        return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), pair.privateKey).toString('base64url')}`;
      };
      const exact = {
        ...input,
        expected: original,
        keys: new Map([['synthetic-deadline', pair.publicKey]]),
        signedAuthorization: encode(original),
      };
      setTime(original.expires_at - 5_001);
      await expect(verifyManagedUseAuthorization(exact)).resolves.toEqual(original);
      // Even an authentic later-issued artifact cannot replace the locally
      // persisted co-issuance result without a new committed authorization.
      await expect(
        verifyManagedUseAuthorization({
          ...exact,
          signedAuthorization: encode({
            ...original,
            issued_at: original.issued_at + 60_000,
            token_expires_at: original.token_expires_at + 60_000,
            expires_at: original.expires_at + 60_000,
          }),
        })
      ).rejects.toMatchObject({ code: 'managed_authority_invalid' });
      setTime(original.expires_at - 5_000);
      await expect(verifyManagedUseAuthorization(exact)).rejects.toMatchObject({
        code: 'managed_authority_expired',
      });
      const restarted = fixture();
      restarted.setTime(original.expires_at);
      await expect(
        verifyManagedUseAuthorization({ ...exact, clock: restarted.input.clock })
      ).rejects.toMatchObject({ code: 'managed_authority_expired' });
    }
  );

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
