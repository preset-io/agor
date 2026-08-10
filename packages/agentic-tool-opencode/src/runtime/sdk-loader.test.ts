import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  loadManagedAgenticToolSdk: vi.fn(),
  resolveManagedAgenticToolIntegration: vi.fn(),
}));
const sourceSdk = vi.hoisted(() => ({ createOpencodeClient: vi.fn() }));

vi.mock('@agor/core/agentic-integrations', () => coreMocks);
vi.mock('@opencode-ai/sdk', () => sourceSdk);

import { loadOpenCodeSdk } from './sdk-loader.js';

describe('OpenCode SDK loading', () => {
  beforeEach(() => {
    vi.stubEnv('AGOR_MANAGED_AGENTIC_TOOLS', '0');
    coreMocks.loadManagedAgenticToolSdk.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the package-owned SDK directly in a source checkout', async () => {
    const sdk = await loadOpenCodeSdk();

    expect(sdk.createOpencodeClient).toBe(sourceSdk.createOpencodeClient);
    expect(coreMocks.loadManagedAgenticToolSdk).not.toHaveBeenCalled();
  });

  it('delegates SDK resolution to the contained integration tree in managed mode', async () => {
    vi.stubEnv('AGOR_MANAGED_AGENTIC_TOOLS', '1');
    const managedSdk = { createOpencodeClient: vi.fn() };
    coreMocks.loadManagedAgenticToolSdk.mockResolvedValue(managedSdk);

    await expect(loadOpenCodeSdk()).resolves.toBe(managedSdk);
    expect(coreMocks.loadManagedAgenticToolSdk).toHaveBeenCalledWith('opencode');
  });
});
