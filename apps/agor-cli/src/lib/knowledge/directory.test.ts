import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertKnowledgeDirectorySupported, KnowledgeDirectory } from './directory';
import { KnowledgeProgress } from './progress';
import { exportKnowledge, type knowledgeTransferClient } from './transfer';

describe('assertKnowledgeDirectorySupported', () => {
  it('accepts POSIX platforms and refuses Windows with a clear reason', () => {
    expect(() => assertKnowledgeDirectorySupported('linux')).not.toThrow();
    expect(() => assertKnowledgeDirectorySupported('darwin')).not.toThrow();
    expect(() => assertKnowledgeDirectorySupported('win32')).toThrow('use WSL');
  });
});

describe.skipIf(process.platform === 'win32')('KnowledgeDirectory', () => {
  let root: string;
  let directory: KnowledgeDirectory | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-directory-'));
  });
  afterEach(async () => {
    await directory?.close();
    directory = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips files and never overwrites a document', async () => {
    directory = await KnowledgeDirectory.open(join(root, 'bundle'), true);
    await directory.lock();
    expect(await directory.hasLock()).toBe(true);
    await directory.write('d000001.md', 'one');
    await expect(directory.write('d000001.md', 'two')).rejects.toThrow();
    await directory.write('manifest.json', '{}');
    await directory.write('manifest.json', '{"a":1}');
    expect(await directory.read('d000001.md', 100)).toBe('one');
    expect(await directory.read('manifest.json', 100)).toBe('{"a":1}');
    expect(await directory.read('checkpoint.json', 100)).toBeNull();
  });

  it('rejects traversal names, symlinked files and a symlinked root', async () => {
    const outside = join(root, 'outside');
    await writeFile(outside, 'secret');
    directory = await KnowledgeDirectory.open(join(root, 'bundle'), true);
    await directory.lock();
    await expect(directory.read('../outside', 100)).rejects.toThrow('Unsafe bundle filename');
    await expect(directory.write('../outside', 'x')).rejects.toThrow('Unsafe bundle filename');
    await symlink(outside, join(root, 'bundle', 'd000001.md'));
    await expect(directory.write('d000001.md', 'overwrite')).rejects.toThrow();
    await link(outside, join(root, 'bundle', 'd000002.md'));
    await expect(directory.read('d000002.md', 100)).rejects.toThrow('Unsafe');
    expect(await readFile(outside, 'utf8')).toBe('secret');

    await mkdir(join(root, 'real'), { mode: 0o700 });
    await symlink(join(root, 'real'), join(root, 'linked'));
    await expect(KnowledgeDirectory.open(join(root, 'linked'), true)).rejects.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('exportKnowledge local preflight', () => {
  it('rejects a non-private output directory before contacting the server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-export-preflight-'));
    const find = vi.fn();
    try {
      await mkdir(join(root, 'bundle'));
      await chmod(join(root, 'bundle'), 0o755);
      await expect(
        exportKnowledge(
          { find } as unknown as ReturnType<typeof knowledgeTransferClient>,
          {
            namespace: 'docs',
            directory: join(root, 'bundle'),
            dryRun: false,
            resume: false,
            sourceIdentity: 'test',
            signal: new AbortController().signal,
          },
          new KnowledgeProgress({ isTTY: false, write: () => true })
        )
      ).rejects.toThrow('private (mode 0700)');
      expect(find).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
