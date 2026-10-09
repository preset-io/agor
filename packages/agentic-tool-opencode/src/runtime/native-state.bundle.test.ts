import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Options } from 'tsup';
import { describe, expect, it } from 'vitest';
import config from '../../tsup.config.js';

describe('native-state bundle', () => {
  it('keeps the node:sqlite specifier with the package build config', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'agor-opencode-bundle-'));
    try {
      await build({
        entry: { state: fileURLToPath(new URL('./native-state.ts', import.meta.url)) },
        format: ['esm'],
        outDir,
        config: false,
        silent: true,
        skipNodeModulesBundle: true,
        removeNodeProtocol: (config as Options).removeNodeProtocol,
      });
      const output = await readFile(join(outDir, 'state.js'), 'utf8');
      expect(output).toContain('import("node:sqlite")');
      expect(output).not.toContain('import("sqlite")');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
