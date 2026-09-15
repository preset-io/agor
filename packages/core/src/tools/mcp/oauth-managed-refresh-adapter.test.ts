import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { managedCommit, managedOwner } from '../../db/test-support/managed-oauth-fixture';
import {
  MCP_OAUTH_JWS_TYPES,
  type McpOAuthRefreshRequest,
  mcpOAuthEgressAudience,
  mcpOAuthReceiptAudience,
  mcpOAuthSha256,
} from '../../types/mcp-managed-oauth-contract';
import { ManagedMCPOAuthClient } from './managed-oauth-client';
import { createManagedOAuthRefreshAdapter, getManagedOAuthDeferredRefresh } from './oauth-refresh';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
it('does not accept an error name or caller-shaped outcome as retained-grant authority', () => {
  expect(
    getManagedOAuthDeferredRefresh(
      Object.assign(new Error('forged'), {
        name: 'ManagedOAuthLocalAdmissionError',
        grantGeneration: 1,
        refreshGeneration: 1,
        grantBindingFingerprint: 'forged',
        outcome: { status: 'not_dispatched' },
      })
    )
  ).toBeUndefined();
  expect(getManagedOAuthDeferredRefresh(null)).toBeUndefined();
});
function fixture() {
  const now = Date.now();
  const owner = managedOwner({
    tenant: 'tenant',
    user: 'user',
    server: 'server',
    attempt: 'attempt',
    generation: 1,
  });
  const claim = {
    kind: 'refresh' as const,
    claim_id: 'operation',
    claimed_at: now - 1000,
    deadline_at: now + 119000,
    refresh_generation: '1',
    refresh_success_generation: '0',
  };
  const commit = managedCommit(owner, claim, '1');
  const use = { ...commit.metadata.use_claims, aud: mcpOAuthEgressAudience(owner) };
  const encode = (claims: unknown, typ: string) => {
    const data = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key', typ })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), pair.privateKey).toString('base64url')}`;
  };
  const useAuthorization = encode(use, MCP_OAUTH_JWS_TYPES.use);
  const receipt = {
    ...commit.metadata.receipt_claims,
    aud: mcpOAuthReceiptAudience(owner),
    use_authorization_digest: mcpOAuthSha256(useAuthorization),
  };
  const signedReceipt = encode(receipt, MCP_OAUTH_JWS_TYPES.receipt);
  const response = {
    protocol_version: 1 as const,
    status: 'succeeded' as const,
    operation_id: 'operation',
    owner,
    claim,
    receipt_id: receipt.receipt_id,
    handle: receipt.handle,
    handle_epoch: receipt.handle_epoch,
    sequence: '1',
    next_sequence: '2',
    issued_at: receipt.issued_at,
    expires_at: receipt.expires_at,
    tokens: commit.tokens,
    signed_receipt: signedReceipt,
    use_authorization: useAuthorization,
  };
  const request: McpOAuthRefreshRequest = {
    protocol_version: 1,
    operation_id: 'operation',
    owner,
    claim,
    handle: receipt.handle,
    handle_epoch: receipt.handle_epoch,
    sequence: '1',
    refresh_token: 'SYNTHETIC_OLD_REFRESH_DO_NOT_REPLAY',
  };
  const client = new ManagedMCPOAuthClient({
    origin: 'https://broker.example.test',
    environment: 'staging',
    region: 'us-west-2',
    cellId: owner.cell_id,
    credentialId: 'synthetic-credential',
    keyId: 'synthetic-key',
    privateKey: pair.privateKey,
    now: () => Date.now(),
  });
  const transport = vi.spyOn(client, 'request').mockResolvedValue(response);
  const adapter = createManagedOAuthRefreshAdapter({
    client,
    issuer: receipt.iss,
    keys: new Map([['synthetic-key', pair.publicKey]]),
    now: () => Date.now(),
    assertCurrent: () => {},
    acknowledge: async () => {},
  });
  return {
    request,
    commit,
    transport,
    adapter,
    use,
    receipt,
    signedReceipt,
    useAuthorization,
    response,
  };
}
describe('managed refresh adapter uses the canonical verified operation transport', () => {
  it('dispatches once and materializes the exact signed claims for the existing repository CAS', async () => {
    const f = fixture();
    const result = await f.adapter.execute({
      request: f.request,
      metadata: f.commit.metadata,
      recoveryOnly: false,
      assertCurrent: () => {},
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.transport.mock.calls[0][0].operation).toBe('refresh');
    expect(result.metadata).toMatchObject({
      transaction_id: f.commit.metadata.transaction_id,
      signed_receipt: f.signedReceipt,
      receipt_claims: f.receipt,
      use_authorization: f.useAuthorization,
      use_claims: f.use,
    });
  });
  it('receipt-only recovery never transmits the stored refresh credential', async () => {
    const f = fixture();
    await f.adapter.execute({
      request: f.request,
      metadata: f.commit.metadata,
      recoveryOnly: true,
      assertCurrent: () => {},
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.transport.mock.calls[0][0].operation).toBe('receipt');
    expect(JSON.stringify(f.transport.mock.calls)).not.toContain(f.request.refresh_token);
  });
  it('rejects forged signed material without a second dispatch', async () => {
    const f = fixture();
    f.transport.mockResolvedValue({
      ...f.response,
      signed_receipt: 'forged.receipt.signature',
    });
    await expect(
      f.adapter.execute({
        request: f.request,
        metadata: f.commit.metadata,
        recoveryOnly: false,
        assertCurrent: () => {},
      })
    ).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
});
