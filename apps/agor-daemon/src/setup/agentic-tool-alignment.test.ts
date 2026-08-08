import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/agentic-integrations', () => ({
  inspectManagedAgenticToolAlignment: vi.fn(),
  resolveManagedAgenticToolVersion: (_fallback: string | undefined, env: NodeJS.ProcessEnv) =>
    env.AGOR_VERSION ?? env.AGOR_INTEGRATION_VERSION,
  resolveAgenticToolSelectionPolicy: vi.fn(
    async (config: { agentic_tools?: { installed?: string[] } }) =>
      config.agentic_tools?.installed !== undefined
        ? { mode: 'declarative', selected: config.agentic_tools.installed, source: 'config.yaml' }
        : { mode: 'local-managed', selected: [], source: 'missing-manifest' }
  ),
}));

import { inspectManagedAgenticToolAlignment } from '@agor/core/agentic-integrations';
import { assertConfiguredAgenticToolsAligned } from './agentic-tool-alignment.js';

const inspect = vi.mocked(inspectManagedAgenticToolAlignment);

describe('assertConfiguredAgenticToolsAligned', () => {
  beforeEach(() => inspect.mockReset().mockResolvedValue([]));

  it('does nothing for source checkouts', async () => {
    await assertConfiguredAgenticToolsAligned(
      { agentic_tools: { installed: ['codex'] } },
      { AGOR_MANAGED_AGENTIC_TOOLS: '0' }
    );
    expect(inspect).not.toHaveBeenCalled();
  });

  it('accepts an exactly aligned configured set', async () => {
    inspect.mockResolvedValue([
      { tool: 'codex', displayName: 'Codex', expectedVersion: '0.24.1', status: 'ready' },
    ]);
    await assertConfiguredAgenticToolsAligned(
      { agentic_tools: { installed: ['codex'] } },
      { AGOR_MANAGED_AGENTIC_TOOLS: '1', AGOR_VERSION: '0.24.1' }
    );
  });

  it('fails with state and the exact repair command', async () => {
    inspect.mockResolvedValue([
      {
        tool: 'codex',
        displayName: 'Codex',
        expectedVersion: '0.24.1',
        status: 'missing-or-invalid',
        detail: 'package is missing',
      },
    ]);
    await expect(
      assertConfiguredAgenticToolsAligned(
        { agentic_tools: { installed: ['codex'] } },
        { AGOR_MANAGED_AGENTIC_TOOLS: '1', AGOR_VERSION: '0.24.1' }
      )
    ).rejects.toThrow(/Codex: missing or invalid[\s\S]*agor install/);
  });

  it('warns but accepts a missing local manifest as an empty selection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      assertConfiguredAgenticToolsAligned(
        {},
        { AGOR_MANAGED_AGENTIC_TOOLS: '1', AGOR_VERSION: '0.24.1' }
      )
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agor install'));
    expect(inspect).toHaveBeenCalledWith([], '0.24.1');
    warn.mockRestore();
  });
});
