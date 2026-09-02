import { describe, expect, it } from 'vitest';
import { initializeToolRegistry, ToolRegistry } from './tool-registry.js';

describe('workload tool registry initialization', () => {
  it('registers only the requested built-in workload handler', async () => {
    await initializeToolRegistry('workload');

    expect(ToolRegistry.getAll()).toEqual(['workload']);
    expect(ToolRegistry.getApiKeyEnvVar('workload')).toBeUndefined();
  });
});
