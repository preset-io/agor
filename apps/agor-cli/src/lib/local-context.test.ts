import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertLocalContextUnlocked,
  assertLocalContextUnlockedWhenIdentified,
} from './local-context';

vi.mock('./auth.js', () => ({ loadToken: vi.fn() }));

import { loadToken } from './auth.js';

const deploymentId = '019c1234-5678-7123-8123-123456789abc';

describe('assertLocalContextUnlocked', () => {
  it('allows the compatibility-only stop/diagnostic path before identity migration', async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    await expect(
      assertLocalContextUnlockedWhenIdentified({ daemon: { port: 3030 } })
    ).resolves.toBe(undefined);
  });

  beforeEach(() => {
    vi.mocked(loadToken).mockReset();
    vi.stubEnv('AGOR_API_KEY', '');
    vi.stubEnv('AGOR_DEPLOYMENT_ID', '');
    vi.stubEnv('DAEMON_URL', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('allows logged-out local administration', async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    await expect(
      assertLocalContextUnlocked({ daemon: { deployment_id: deploymentId } })
    ).resolves.toBeUndefined();
  });

  it('allows a login to the same deployment', async () => {
    vi.mocked(loadToken).mockResolvedValue({
      version: 2,
      target: {
        url: 'https://agor.example.com',
        origin: 'https://agor.example.com',
        deploymentId,
      },
      accessToken: 'secret',
      user: { user_id: 'u1', email: 'max@example.com', role: 'admin' },
      expiresAt: Date.now() + 1000,
    });
    await expect(
      assertLocalContextUnlocked({ daemon: { deployment_id: deploymentId } })
    ).resolves.toBeUndefined();
  });

  it('locks local administration for a different login', async () => {
    vi.mocked(loadToken).mockResolvedValue({
      version: 2,
      target: {
        url: 'https://cloud.agor.live',
        origin: 'https://cloud.agor.live',
        deploymentId: '019c9999-5678-7123-8123-123456789abc',
      },
      accessToken: 'secret',
      user: { user_id: 'u1', email: 'max@example.com', role: 'admin' },
      expiresAt: Date.now() + 1000,
    });
    await expect(
      assertLocalContextUnlocked({ daemon: { deployment_id: deploymentId } })
    ).rejects.toThrow('Local administration is locked');
  });

  it('locks local administration for a different API-key environment target', async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.stubEnv('AGOR_API_KEY', 'agor_sk_test');
    vi.stubEnv('AGOR_DEPLOYMENT_ID', '019c9999-5678-7123-8123-123456789abc');
    vi.stubEnv('DAEMON_URL', 'https://cloud.agor.live');

    await expect(
      assertLocalContextUnlocked({ daemon: { deployment_id: deploymentId } })
    ).rejects.toThrow('Local administration is locked');
  });
});
