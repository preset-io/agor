import { describe, expect, it, vi } from 'vitest';
import {
  exchangeCodexDeviceAuthorization,
  pollCodexDeviceAuthorization,
} from './codex-device-auth-flow.js';
import {
  type CodexDeviceAuthProvider,
  DeviceAuthProviderError,
} from './codex-device-auth-provider.js';

function provider(
  poll: Awaited<ReturnType<CodexDeviceAuthProvider['pollDeviceToken']>> | Error,
  exchange: Awaited<ReturnType<CodexDeviceAuthProvider['exchangeCodeForTokens']>> | Error = {
    idToken: 'id',
    accessToken: 'access',
    refreshToken: 'refresh',
  }
): CodexDeviceAuthProvider {
  return {
    requestUserCode: vi.fn(),
    pollDeviceToken: vi.fn(async () => {
      if (poll instanceof Error) throw poll;
      return poll;
    }),
    exchangeCodeForTokens: vi.fn(async () => {
      if (exchange instanceof Error) throw exchange;
      return exchange;
    }),
  };
}

describe('Codex device protocol decisions', () => {
  const input = { deviceAuthId: 'device', userCode: 'CODE', intervalMs: 5_000 };

  it('normalizes pending, slow-down, and transient poll outcomes to retries', async () => {
    await expect(
      pollCodexDeviceAuthorization(provider({ outcome: 'pending' }), input)
    ).resolves.toEqual({ outcome: 'retry', intervalMs: 5_000 });
    await expect(
      pollCodexDeviceAuthorization(
        provider({ outcome: 'slow_down', intervalIncreaseMs: 5_000 }),
        input
      )
    ).resolves.toEqual({ outcome: 'retry', intervalMs: 10_000 });
    await expect(
      pollCodexDeviceAuthorization(
        provider(new DeviceAuthProviderError('transient', 'poll_http_503')),
        input
      )
    ).resolves.toEqual({ outcome: 'retry', intervalMs: 5_000 });
  });

  it('preserves definitive poll outcomes', async () => {
    const approved = { authorizationCode: 'code', codeVerifier: 'verifier' };
    await expect(
      pollCodexDeviceAuthorization(
        provider(new DeviceAuthProviderError('terminal', 'poll_contract')),
        input
      )
    ).resolves.toEqual({ outcome: 'failed' });
    await expect(
      pollCodexDeviceAuthorization(provider({ outcome: 'denied' }), input)
    ).resolves.toEqual({ outcome: 'denied' });
    await expect(
      pollCodexDeviceAuthorization(provider({ outcome: 'expired' }), input)
    ).resolves.toEqual({ outcome: 'expired' });
    await expect(
      pollCodexDeviceAuthorization(provider({ outcome: 'approved', approved }), input)
    ).resolves.toEqual({ outcome: 'approved', approved });
  });

  it('classifies the one-shot exchange without retrying ambiguity', async () => {
    const approved = { authorizationCode: 'code', codeVerifier: 'verifier' };
    const tokens = { idToken: 'id', accessToken: 'access', refreshToken: 'refresh' };
    await expect(
      exchangeCodexDeviceAuthorization(
        provider({ outcome: 'approved', approved }, tokens),
        approved
      )
    ).resolves.toEqual({ outcome: 'tokens', tokens });
    await expect(
      exchangeCodexDeviceAuthorization(
        provider(
          { outcome: 'approved', approved },
          new DeviceAuthProviderError('terminal', 'exchange_http_400')
        ),
        approved
      )
    ).resolves.toEqual({ outcome: 'failed', certainty: 'definitive' });
    await expect(
      exchangeCodexDeviceAuthorization(
        provider({ outcome: 'approved', approved }, new Error('uncertain transport')),
        approved
      )
    ).resolves.toEqual({ outcome: 'failed', certainty: 'ambiguous' });
  });
});
