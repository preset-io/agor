import { describe, expect, it, vi } from 'vitest';
import { initializeToolRegistry, ToolRegistry } from './tool-registry.js';

vi.mock('./claude.js', () => {
  throw new Error('provider module imported for workload: claude');
});
vi.mock('./codex.js', () => {
  throw new Error('provider module imported for workload: codex');
});
vi.mock('./opencode.js', () => {
  throw new Error('provider module imported for workload: opencode');
});
vi.mock('./copilot.js', () => {
  throw new Error('provider module imported for workload: copilot');
});

describe('workload tool registry initialization', () => {
  it('registers only the requested built-in workload handler', async () => {
    await initializeToolRegistry('workload');

    expect(ToolRegistry.getAll()).toEqual(['workload']);
    expect(ToolRegistry.getApiKeyEnvVar('workload')).toBeUndefined();
  });
});
