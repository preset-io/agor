import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  const vendorDirectory = join(
    getAgenticToolInstallDir('claude-code', version),
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk'
  );
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(vendorDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: '@agor/claude', type: 'module', exports: './index.js' })
  );
  await writeFile(
    join(vendorDirectory, 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk',
      type: 'module',
      exports: './index.js',
    })
  );
  await writeFile(join(vendorDirectory, 'index.js'), 'export const vendor = true;');
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

  it.skipIf(process.platform === 'win32')(
    'rejects a vendor dependency symlinked outside the managed tree',
    async () => {
      const packageDirectory = await createFakeManagedClaude('1.2.6');
      await writeFile(
        join(packageDirectory, 'index.js'),
        "export const AGOR_INTEGRATION_VERSION = '1.2.6'; export const sdk = {};"
      );
      const vendorDirectory = join(
        packageDirectory,
        '..',
        '..',
        '@anthropic-ai',
        'claude-agent-sdk'
      );
      const outside = await mkdtemp(join(tmpdir(), 'agor-agentic-vendor-'));
      temporaryDirectories.push(outside);
      await writeFile(
        join(outside, 'package.json'),
        JSON.stringify({ type: 'module', exports: './index.js' })
      );
      await writeFile(join(outside, 'index.js'), 'export const vendor = true;');
      await rm(vendorDirectory, { recursive: true });
      await symlink(outside, vendorDirectory, 'dir');

      await expect(loadManagedAgenticToolSdk('claude-code')).rejects.toThrow(
        'Run: agor install claude'
      );
    }
  );

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
