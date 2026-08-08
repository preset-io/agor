import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnoseAgenticTools } from './agentic-tool-diagnostics.js';

const originalRoot = process.env.AGOR_AGENTIC_TOOLS_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.AGOR_AGENTIC_TOOLS_DIR;
  else process.env.AGOR_AGENTIC_TOOLS_DIR = originalRoot;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('agentic tool diagnostics', () => {
  it('reports integrations that are not installed for this Agor version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-agentic-tools-'));
    temporaryDirectories.push(directory);
    process.env.AGOR_AGENTIC_TOOLS_DIR = directory;

    const diagnostics = await diagnoseAgenticTools('0.24.0');

    expect(diagnostics).toHaveLength(6);
    expect(diagnostics.every((tool) => tool.status === 'missing')).toBe(true);
    expect(diagnostics.find((tool) => tool.id === 'claude-code')?.detail).toBe(
      'Run: agor install claude'
    );
  });

  it('reports a corrupt managed integration as unusable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-agentic-tools-'));
    temporaryDirectories.push(directory);
    process.env.AGOR_AGENTIC_TOOLS_DIR = directory;
    const install = join(directory, '0.24.0', 'codex');
    await mkdir(install, { recursive: true });
    await writeFile(
      join(install, 'agor-integration.json'),
      JSON.stringify({
        agorVersion: '0.24.0',
        packageName: '@agor-live/codex',
        packageVersion: '0.24.0',
        installedAt: new Date().toISOString(),
      })
    );

    const diagnostics = await diagnoseAgenticTools('0.24.0');
    const codex = diagnostics.find((tool) => tool.id === 'codex');

    expect(codex).toMatchObject({ status: 'unusable', path: install });
    expect(codex?.detail).toContain('agor install codex');
  });
});
