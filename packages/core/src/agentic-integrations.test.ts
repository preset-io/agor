import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAgenticToolInstallDir, loadManagedAgenticToolSdk } from './agentic-integrations.js';

const originalEnv = {
  AGOR_AGENTIC_TOOLS_DIR: process.env.AGOR_AGENTIC_TOOLS_DIR,
  AGOR_MANAGED_AGENTIC_TOOLS: process.env.AGOR_MANAGED_AGENTIC_TOOLS,
  AGOR_VERSION: process.env.AGOR_VERSION,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function createFakeManagedClaude(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agor-agentic-tools-'));
  temporaryDirectories.push(root);
  process.env.AGOR_AGENTIC_TOOLS_DIR = root;
  process.env.AGOR_MANAGED_AGENTIC_TOOLS = '1';
  process.env.AGOR_VERSION = version;
  const packageDirectory = join(
    getAgenticToolInstallDir('claude-code', version),
    'node_modules',
    '@agor',
    'claude'
  );
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: '@agor/claude', type: 'module', exports: './index.js' })
  );
  return packageDirectory;
}

describe('managed agentic tool loading', () => {
  it('loads only the version-aligned package from the managed directory', async () => {
    const packageDirectory = await createFakeManagedClaude('1.2.3');
    await writeFile(
      join(packageDirectory, 'index.js'),
      "export const AGOR_INTEGRATION_VERSION = '1.2.3'; export const sdk = { marker: 'managed' };"
    );

    await expect(loadManagedAgenticToolSdk<{ marker: string }>('claude-code')).resolves.toEqual({
      marker: 'managed',
    });
  });

  it('rejects a package built for another Agor version', async () => {
    const packageDirectory = await createFakeManagedClaude('1.2.4');
    await writeFile(
      join(packageDirectory, 'index.js'),
      "export const AGOR_INTEGRATION_VERSION = '1.2.3'; export const sdk = {};"
    );

    await expect(loadManagedAgenticToolSdk('claude-code')).rejects.toThrow(
      'does not match Agor 1.2.4'
    );
  });

  it('returns an actionable error when support is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-agentic-tools-'));
    temporaryDirectories.push(root);
    process.env.AGOR_AGENTIC_TOOLS_DIR = root;
    process.env.AGOR_MANAGED_AGENTIC_TOOLS = '1';
    process.env.AGOR_VERSION = '1.2.5';

    await expect(loadManagedAgenticToolSdk('claude-code')).rejects.toThrow(
      'Run: agor install claude'
    );
  });
});
