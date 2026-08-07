import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnoseAgenticTools } from './agentic-tool-diagnostics.js';

const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform === 'win32')('agentic tool diagnostics', () => {
  it('reports an incompatible OpenCode CLI as unusable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-agentic-tools-'));
    temporaryDirectories.push(directory);
    const binary = join(directory, 'opencode');
    await writeFile(binary, "#!/bin/sh\nprintf '9.9.9\\n'\n");
    await chmod(binary, 0o755);
    process.env.PATH = directory;

    const diagnostics = await diagnoseAgenticTools();
    const opencode = diagnostics.find((tool) => tool.id === 'opencode');

    expect(opencode).toMatchObject({
      status: 'unusable',
      path: binary,
    });
    expect(opencode?.detail).toContain("incompatible with Agor's pinned SDK");
  });
});
