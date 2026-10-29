import { analyticsLogger } from '@agor/core/analytics';
import type { CodexDeviceAuthAttemptRecord } from '@agor/core/db';
import { getCurrentTenantId, runWithTenantContext } from '@agor/core/db';
import type { UserID } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexDeviceAuthAttemptAuthority } from './codex-device-auth-attempt-authority.js';
import { createDurableCodexDeviceAuthService } from './codex-device-auth-durable';

vi.mock('@agor/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/config')>()),
  isTenantAgenticToolEnabled: vi.fn(async () => true),
}));
vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  // The service only scopes tenant reads that are mocked here; no database is involved.
  runWithTenantDatabaseScope: vi.fn(
    (_db: unknown, _tenant: unknown, work: (db: unknown) => unknown) => work({})
  ),
}));
vi.mock('./codex-auth-shared.js', () => ({
  resolveCodexCredentialRoute: vi.fn(async () => ({ ok: true, delegatedHomeKey: null })),
  sameCodexCredentialRoute: vi.fn(() => true),
  persistVerifiedCodexAuth: vi.fn(async () => ({ authMode: 'chatgpt', planType: 'pro' })),
}));
vi.mock('./codex-device-auth-flow.js', () => ({
  pollCodexDeviceAuthorization: vi.fn(async () => ({
    outcome: 'approved',
    approved: { authorizationCode: 'authz', codeVerifier: 'verifier', codeChallenge: 'c' },
  })),
  exchangeCodexDeviceAuthorization: vi.fn(async () => ({
    outcome: 'tokens',
    tokens: { idToken: 'id', accessToken: 'access-tok', refreshToken: 'refresh-tok' },
  })),
}));
vi.mock('./codex-device-auth-provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codex-device-auth-provider.js')>()),
  buildDeviceAuthJson: vi.fn(() => ({})),
}));

const USER_ID = '019f1bc1-bb61-7ea4-b9e1-0ecc173cccfb' as UserID;
const AUTH = { user: { user_id: USER_ID } } as never;

/** In-memory stand-in for the PostgreSQL attempt authority; `committedRuns` caps successful finalizes. */
function fakeAuthority(committedRuns: number) {
  let record = {
    attemptId: 'attempt-1',
    status: 'pending',
    isCurrent: true,
    pollNextAt: new Date(0),
    pollIntervalMs: 1,
  } as unknown as CodexDeviceAuthAttemptRecord;
  let remaining = committedRuns;
  const authority = {
    maintain: vi.fn(async () => undefined),
    reserve: vi.fn(async () => ({ record })),
    attachGrant: vi.fn(async () => record),
    getCurrentForUser: vi.fn(async () => record),
    claimPoll: vi.fn(async () => record),
    open: vi.fn(() => ({ deviceAuthId: 'device-1', userCode: 'ABCD-1234' })),
    claimExchange: vi.fn(async () => ({ record })),
    finalize: vi.fn(async (_exchange: unknown, work: (route: unknown) => Promise<unknown>) => {
      if (remaining <= 0) return { outcome: 'stale' as const };
      remaining -= 1;
      await work({ delegatedHomeKey: null });
      return { outcome: 'committed' as const, value: undefined };
    }),
    finish: () => {
      record = { ...record, status: 'succeeded' } as CodexDeviceAuthAttemptRecord;
    },
  };
  return authority;
}

function recordVerified() {
  const seen: unknown[] = [];
  vi.spyOn(analyticsLogger, 'track').mockImplementation((event, properties) => {
    if (event === 'llm.credential_verified') seen.push([getCurrentTenantId(), properties]);
  });
  return seen;
}

const VERIFIED = { agentic_tool: 'codex', method: 'codex_device', result: 'authenticated' };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('HA Codex device sign-in analytics', () => {
  it('records one verification for the committed sign-in, in the starting tenant', async () => {
    const seen = recordVerified();
    const authority = fakeAuthority(1);
    const invalidate = vi.fn(async () => undefined);
    const service = createDurableCodexDeviceAuthService(
      { get: vi.fn(() => ({})), service: vi.fn() } as never,
      {} as never,
      authority as unknown as CodexDeviceAuthAttemptAuthority,
      { requestUserCode: vi.fn(async () => ({ deviceAuthId: 'device-1' })) } as never,
      invalidate
    );
    await runWithTenantContext('tenant-a', () => service.create({}, AUTH));
    await vi.waitFor(() => expect(authority.finalize).toHaveBeenCalled());
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    // Later polls of the same attempt reach finalize again but only see a stale outcome.
    await vi.waitFor(() => expect(authority.finalize.mock.calls.length).toBeGreaterThan(1));
    authority.finish();
    expect(seen).toEqual([['tenant-a', VERIFIED]]);
    expect(invalidate).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      userId: USER_ID,
      reason: 'credentials_imported',
    });
  });
});
