import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPENCODE_VERSION } from '../shared/known-models.js';
import { assertOpenCodeBinaryCompatibility, readOpenCodeBinaryVersion } from './binary.js';

const temporaryDirectories: string[] = [];

async function versionBinary(output: string) {
  const directory = await mkdtemp(join(tmpdir(), 'agor-opencode-version-'));
  temporaryDirectories.push(directory);
  const binary = join(directory, 'opencode');
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  await chmod(binary, 0o755);
  return binary;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform === 'win32')('OpenCode binary compatibility', () => {
  it('accepts the CLI version pinned to the SDK', async () => {
    const binary = await versionBinary(`opencode version ${OPENCODE_VERSION}`);

    await expect(readOpenCodeBinaryVersion(binary)).resolves.toBe(OPENCODE_VERSION);
    await expect(assertOpenCodeBinaryCompatibility(binary)).resolves.toBe(OPENCODE_VERSION);
  });

  it('rejects a CLI version that can drift from the pinned SDK', async () => {
    const binary = await versionBinary('opencode version 9.9.9');

    await expect(assertOpenCodeBinaryCompatibility(binary)).rejects.toThrow(
      `OpenCode CLI 9.9.9 is incompatible with Agor's pinned SDK ${OPENCODE_VERSION}`
    );
  });

  it('rejects unparseable version output', async () => {
    const binary = await versionBinary('unknown');

    await expect(readOpenCodeBinaryVersion(binary)).rejects.toThrow(
      'Could not parse OpenCode version'
    );
  });
});
