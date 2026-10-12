import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_ARTIFACT_FILE_BYTES,
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

  it('bounds file count independently of source bytes and serialized request size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-artifact-'));
    const files = Object.fromEntries(
      Array.from({ length: MAX_ARTIFACT_FILE_COUNT }, (_, index) => [`/fictional-${index}.txt`, ''])
    );
    await Promise.all(Object.keys(files).map((path) => writeFile(join(root, path.slice(1)), '')));
    expect(await readArtifactTree(root)).toEqual(files);

    const extraFiles = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`/extra-${index}.txt`, ''])
    );
    // Even 1,200 empty files fit comfortably in the byte budget.
    expect(Buffer.byteLength(JSON.stringify({ files: { ...files, ...extraFiles } }))).toBeLessThan(
      MAX_ARTIFACT_TOTAL_BYTES
    );
    await Promise.all(
      Object.keys(extraFiles).map((path) => writeFile(join(root, path.slice(1)), ''))
    );
    await expect(readArtifactTree(root)).rejects.toThrow(
      `Artifact contains more than ${MAX_ARTIFACT_FILE_COUNT} files. This file-count limit bounds filesystem work independently of byte size; reduce the number of source files.`
    );
  });

  it('enforces the per-file byte limit inclusively', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-artifact-'));
    const content = 'x'.repeat(MAX_ARTIFACT_FILE_BYTES);
    await writeFile(join(root, 'fictional.txt'), content);
    expect(await readArtifactTree(root)).toEqual({ '/fictional.txt': content });

    await writeFile(join(root, 'fictional.txt'), `${content}x`);
    await expect(readArtifactTree(root)).rejects.toMatchObject({
      message: `Artifact file /fictional.txt is ${MAX_ARTIFACT_FILE_BYTES + 1} bytes, exceeding the ${MAX_ARTIFACT_FILE_BYTES}-byte per-file limit`,
    });
  });

  it('enforces the aggregate byte limit with individually valid files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-artifact-'));
    const first = 'x'.repeat(Math.floor(MAX_ARTIFACT_TOTAL_BYTES / 2));
    const second = 'x'.repeat(MAX_ARTIFACT_TOTAL_BYTES - first.length);
    expect(Math.max(first.length, second.length + 1)).toBeLessThanOrEqual(MAX_ARTIFACT_FILE_BYTES);
    await writeFile(join(root, 'first.txt'), first);
    await writeFile(join(root, 'second.txt'), second);
    expect(await readArtifactTree(root)).toEqual({
      '/first.txt': first,
      '/second.txt': second,
    });

    await writeFile(join(root, 'second.txt'), `${second}x`);
    await expect(readArtifactTree(root)).rejects.toMatchObject({
      message: `Artifact source is ${MAX_ARTIFACT_TOTAL_BYTES + 1} bytes, exceeding the ${MAX_ARTIFACT_TOTAL_BYTES}-byte total limit`,
    });
  });

  it('reports invalid UTF-8 with encoding-specific remediation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-artifact-'));
    await writeFile(join(root, 'latin1.css'), Buffer.from('/* café */', 'latin1'));

    await expect(readArtifactTree(root)).rejects.toThrow(
      'Artifact file /latin1.css is not valid UTF-8 text. Re-save text files as UTF-8; embed binary assets as data URLs in a source file or use a controlled external URL.'
    );
  });

  it('preserves UTF-8 text including a leading BOM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-artifact-'));
    const content = '\uFEFF/* café */';
    await writeFile(join(root, 'utf8.css'), content);
    expect(await readArtifactTree(root)).toEqual({ '/utf8.css': content });
  });
});
