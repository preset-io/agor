import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertTrustedAncestors,
  KnowledgeDirectory,
  type KnowledgeDirectoryAnchor,
  knowledgeDirectoryAnchor,
} from './directory';
import { KnowledgeProgress } from './progress';
import { exportKnowledge, type knowledgeTransferClient } from './transfer';

describe('knowledgeDirectoryAnchor', () => {
  it('pins through /proc on Linux, uses checked paths on other POSIX, and refuses Windows', () => {
    expect(knowledgeDirectoryAnchor('linux')).toBe('proc-fd');
    expect(knowledgeDirectoryAnchor('darwin')).toBe('path');
    expect(knowledgeDirectoryAnchor('freebsd')).toBe('path');
    expect(() => knowledgeDirectoryAnchor('win32')).toThrow('not supported on Windows');
  });
});

const posix = process.platform !== 'win32';
// The Linux run exercises both anchors; macOS/other POSIX exercises the path anchor.
const anchors: KnowledgeDirectoryAnchor[] =
  process.platform === 'linux' ? ['proc-fd', 'path'] : ['path'];
// Sandboxed CI (user namespaces) may map `/` to an overflow uid instead of root.
async function trustedOwners() {
  return [0, process.getuid?.() ?? 0, (await stat('/')).uid];
}

describe.skipIf(!posix).each(anchors)('KnowledgeDirectory (%s anchor)', (anchor) => {
  let root: string;
  let directory: KnowledgeDirectory | undefined;
  let options: { anchor: KnowledgeDirectoryAnchor; trustedOwners: number[] };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-directory-anchor-'));
    options = { anchor, trustedOwners: await trustedOwners() };
  });
  afterEach(async () => {
    await directory?.close();
    directory = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips files and never overwrites a document', async () => {
    directory = await KnowledgeDirectory.open(join(root, 'bundle'), true, options);
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

  it('rejects traversal names, symlinks, hardlinks and a symlinked root', async () => {
    const outside = join(root, 'outside');
    await writeFile(outside, 'secret');
    directory = await KnowledgeDirectory.open(join(root, 'bundle'), true, options);
    await directory.lock();
    await expect(directory.read('../outside', 100)).rejects.toThrow('Unsafe bundle filename');
    await expect(directory.write('../outside', 'x')).rejects.toThrow('Unsafe bundle filename');
    await symlink(outside, join(root, 'bundle', 'd000001.md'));
    await expect(directory.read('d000001.md', 100)).rejects.toThrow();
    await expect(directory.write('d000001.md', 'overwrite')).rejects.toThrow();
    await link(outside, join(root, 'bundle', 'd000002.md'));
    await expect(directory.read('d000002.md', 100)).rejects.toThrow('Unsafe');
    expect(await readFile(outside, 'utf8')).toBe('secret');

    await mkdir(join(root, 'real'), { mode: 0o700 });
    await symlink(join(root, 'real'), join(root, 'linked'));
    await expect(KnowledgeDirectory.open(join(root, 'linked'), true, options)).rejects.toThrow();
  });

  it('refuses a non-private export directory', async () => {
    await mkdir(join(root, 'bundle'));
    await chmod(join(root, 'bundle'), 0o755);
    await expect(KnowledgeDirectory.open(join(root, 'bundle'), true, options)).rejects.toThrow(
      'private (mode 0700)'
    );
  });

  it('keeps operations on the opened root, or fails, after the path is swapped', async () => {
    directory = await KnowledgeDirectory.open(join(root, 'bundle'), true, options);
    await directory.lock();
    await directory.write('manifest.json', 'original');
    await rename(join(root, 'bundle'), join(root, 'moved'));
    await mkdir(join(root, 'bundle'), { mode: 0o700 });
    await writeFile(join(root, 'bundle', 'manifest.json'), 'attacker');
    if (anchor === 'proc-fd') {
      // The FD follows the inode, so the swap is invisible and harmless.
      expect(await directory.read('manifest.json', 100)).toBe('original');
      await directory.write('d000001.md', 'pinned');
      expect(await readFile(join(root, 'moved', 'd000001.md'), 'utf8')).toBe('pinned');
    } else {
      await expect(directory.read('manifest.json', 100)).rejects.toThrow('moved or replaced');
      await expect(directory.write('d000001.md', 'x')).rejects.toThrow('moved or replaced');
    }
    await expect(readFile(join(root, 'bundle', 'd000001.md'))).rejects.toThrow();
  });
});

describe.skipIf(!posix)('assertTrustedAncestors', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-ancestors-'));
  });
  afterEach(async () => {
    await chmod(join(root, 'shared'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it('accepts private and sticky shared ancestors, rejects others-writable or foreign ones', async () => {
    const trusted = await trustedOwners();
    await expect(assertTrustedAncestors(root, trusted)).resolves.toBeUndefined();
    await mkdir(join(root, 'shared', 'bundle-parent'), { recursive: true });
    await chmod(join(root, 'shared'), 0o777);
    await expect(
      assertTrustedAncestors(join(root, 'shared', 'bundle-parent'), trusted)
    ).rejects.toThrow('Unsafe Knowledge bundle location');
    await expect(
      KnowledgeDirectory.open(join(root, 'shared', 'bundle-parent', 'bundle'), true, {
        anchor: 'path',
        trustedOwners: trusted,
      })
    ).rejects.toThrow('Unsafe Knowledge bundle location');
    await chmod(join(root, 'shared'), 0o1777);
    await expect(
      assertTrustedAncestors(join(root, 'shared', 'bundle-parent'), trusted)
    ).resolves.toBeUndefined();
    // Ancestors owned by an untrusted user are refused.
    await expect(assertTrustedAncestors(root, [0])).rejects.toThrow(
      'Unsafe Knowledge bundle location'
    );
  });
});

describe.skipIf(!posix)('exportKnowledge local preflight', () => {
  it('rejects an unsafe output directory before contacting the server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-export-preflight-'));
    const find = vi.fn();
    try {
      await mkdir(join(root, 'bundle'), { mode: 0o755 });
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
