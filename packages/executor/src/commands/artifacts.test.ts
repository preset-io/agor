import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_ARTIFACT_FILE_COUNT,
  MAX_ARTIFACT_TOTAL_BYTES,
  readArtifactTree,
} from './artifacts.js';
import { resolvePathInsideBranch } from './branch-filesystem.js';

describe('executor artifact filesystem operations', () => {
  it('reads a branch artifact tree without sidecars, env files, dependencies, or symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-artifact-'));
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;');
    await writeFile(join(root, 'agor.artifact.json'), '{}');
    await writeFile(join(root, '.env'), 'SECRET=nope');
    await writeFile(join(root, 'node_modules', 'dependency.js'), 'ignored');
    await symlink(join(root, 'src', 'index.ts'), join(root, 'linked.ts'));

    expect(await readArtifactTree(root)).toEqual({
      '/src/index.ts': 'export const value = 1;',
    });
  });

  it('rejects traversal and existing-prefix symlink escapes for write destinations', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agor-artifact-'));
    const root = join(parent, 'branch');
    const outside = join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, 'linked'));

    await expect(resolvePathInsideBranch(root, '../outside/file.ts')).rejects.toThrow(
      /escapes branch root/i
    );
    await expect(resolvePathInsideBranch(root, 'linked/file.ts')).rejects.toThrow(/symlink/i);
  });

  it('rejects fictional WebP bytes instead of corrupting them into an oversized UTF-8 frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-artifact-'));
    // Valid 1x1 WebP generated from a fictional solid-color pixel.
    const webp = Buffer.from(
      'UklGRjYAAABXRUJQVlA4ICoAAACwAQCdASoBAAEAAUAmJZgCdLoABGaAAP7y63/uDM+rscP+41tz9YgAAAA=',
      'base64'
    );
    await writeFile(join(root, 'fictional-portrait.webp'), webp);

    await expect(readArtifactTree(root)).rejects.toThrow(
      /unsupported binary artifact file.*UTF-8 text/i
    );
  });

  it('bounds artifact file count and total source bytes', async () => {
    const countRoot = await mkdtemp(join(tmpdir(), 'agor-artifact-'));
    await Promise.all(
      Array.from({ length: MAX_ARTIFACT_FILE_COUNT + 1 }, (_, index) =>
        writeFile(join(countRoot, `fictional-${index}.txt`), '')
      )
    );
    await expect(readArtifactTree(countRoot)).rejects.toThrow(/more than .* files/i);

    const sizeRoot = await mkdtemp(join(tmpdir(), 'agor-artifact-'));
    await writeFile(join(sizeRoot, 'fictional.txt'), 'x'.repeat(MAX_ARTIFACT_TOTAL_BYTES + 1));
    await expect(readArtifactTree(sizeRoot)).rejects.toThrow(/per-file limit|total limit/i);
  });
});
