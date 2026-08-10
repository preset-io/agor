import { describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  loadManagedAgenticToolSdk: vi.fn(),
  resolveManagedAgenticToolIntegration: vi.fn(),
}));
const sourceSdk = vi.hoisted(() => ({ createOpencodeClient: vi.fn() }));

vi.mock('@agor/core/agentic-integrations', () => coreMocks);
vi.mock('@opencode-ai/sdk', () => sourceSdk);

import { loadOpenCodeSdk } from './sdk-loader.js';

describe('OpenCode SDK loading', () => {
  it('resolves the package-owned SDK directly in a source checkout', async () => {
    expect(process.env.AGOR_MANAGED_AGENTIC_TOOLS).not.toBe('1');

    const sdk = await loadOpenCodeSdk();

    expect(sdk.createOpencodeClient).toBe(sourceSdk.createOpencodeClient);
    expect(coreMocks.loadManagedAgenticToolSdk).not.toHaveBeenCalled();
  });
});
