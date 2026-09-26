import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { lock } from 'proper-lockfile';

/**
 * How bundle entries are addressed relative to the opened root.
 * - `proc-fd` (Linux): `/proc/self/fd/N/name` resolves through the pinned directory
 *   FD, so a later swap of any path component cannot redirect an operation.
 * - `path` (macOS, other POSIX): Node has no `openat`, so entries are addressed by
 *   canonical path. Swap resistance instead comes from requiring every ancestor to
 *   be modifiable only by root or the caller (sticky shared dirs allowed), plus a
 *   dev/ino recheck of the root before every entry operation.
 */
export type KnowledgeDirectoryAnchor = 'proc-fd' | 'path';

export function knowledgeDirectoryAnchor(
  platform: NodeJS.Platform = process.platform
): KnowledgeDirectoryAnchor {
  if (platform === 'win32')
    throw new Error(
      'Knowledge export/import is not supported on Windows yet (no O_NOFOLLOW or POSIX ownership checks); run the CLI under WSL, macOS or Linux'
    );
  return platform === 'linux' ? 'proc-fd' : 'path';
}

const defaultTrustedOwners = () => [0, ...(process.getuid ? [process.getuid()] : [])];
const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** Reject ancestors another non-root user could rename, replace or re-point. */
export async function assertTrustedAncestors(
  directory: string,
  trustedOwners: readonly number[] = defaultTrustedOwners()
) {
  for (let current = directory; ; ) {
    const stat = await lstat(current);
    const trustedOwner = trustedOwners.includes(stat.uid);
    const shared = (stat.mode & 0o022) !== 0;
    if (!stat.isDirectory() || !trustedOwner || (shared && (stat.mode & 0o1000) === 0))
      throw new Error(
        `Unsafe Knowledge bundle location: ${current} must be a directory owned by you or root and not writable by others (sticky shared directories are allowed)`
      );
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Flat, manifest-addressed bundle files. The root is pinned against swaps (see anchor). */
export class KnowledgeDirectory {
  private constructor(
    private handle: FileHandle,
    readonly path: string,
    private writable: boolean,
    private anchor: KnowledgeDirectoryAnchor,
    private root: Stats
  ) {}
  private locked = false;
  private release: (() => Promise<void>) | undefined;
  static async open(
    path: string,
    writable = false,
    {
      anchor = knowledgeDirectoryAnchor(),
      trustedOwners,
    }: { anchor?: KnowledgeDirectoryAnchor; trustedOwners?: readonly number[] } = {}
  ): Promise<KnowledgeDirectory> {
    let absolute = resolve(path);
    if (anchor === 'path') {
      // Canonicalize only the parent so a symlinked final component is still refused.
      const parent = await realpath(dirname(absolute));
      await assertTrustedAncestors(parent, trustedOwners);
      absolute = join(parent, basename(absolute));
    }
    if (writable)
      await mkdir(absolute, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const stat = await handle.stat();
    if (writable && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
      await handle.close();
      throw new Error('Export directory must be owned by you and private (mode 0700)');
    }
    const directory = new KnowledgeDirectory(handle, absolute, writable, anchor, stat);
    try {
      await directory.verifyRoot();
    } catch (error) {
      await handle.close();
      throw error;
    }
    return directory;
  }
  private get base() {
    return this.anchor === 'proc-fd' ? `/proc/self/fd/${this.handle.fd}` : this.path;
  }
  /** Path mode only: the path must still name the directory we opened. */
  private async verifyRoot() {
    if (this.anchor !== 'path') return;
    const current = await lstat(this.path).catch(() => null);
    if (!current?.isDirectory() || !sameInode(current, this.root))
      throw new Error('Knowledge bundle directory was moved or replaced during transfer');
  }
  private async entry(name: string) {
    if (
      !/^(?:d[0-9]{6}(?:-[a-f0-9]{64})?\.md|manifest\.json|checkpoint\.json|\.lock|\.tmp-[a-f0-9-]+)$/.test(
        name
      )
    )
      throw new Error('Unsafe bundle filename');
    await this.verifyRoot();
    return `${this.base}/${name}`;
  }
  async lock() {
    if (!this.writable) throw new Error('Read-only bundle');
    this.release = await lock(this.base, {
      realpath: false,
      lockfilePath: await this.entry('.lock'),
      stale: 30_000,
      update: 10_000,
      onCompromised: () => {
        this.locked = false;
      },
    });
    this.locked = true;
  }
  async hasLock(): Promise<boolean> {
    try {
      await lstat(await this.entry('.lock'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  async read(name: string, limit: number): Promise<string | null> {
    let file: FileHandle;
    try {
      file = await open(
        await this.entry(name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      await this.verifyRoot();
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
        throw new Error(`Unsafe or oversized bundle file: ${name}`);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - bytes));
        const result = await file.read(chunk, 0, chunk.length, null);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
        if (bytes > limit) throw new Error(`Bundle file exceeds limit: ${name}`);
        chunks.push(chunk.subarray(0, result.bytesRead));
      }
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks)
      );
    } finally {
      await file.close();
    }
  }
  async write(name: string, content: string) {
    if (!this.locked) throw new Error('Bundle write requires exclusive lock');
    const temporary = `.tmp-${randomUUID()}`;
    const file = await open(await this.entry(temporary), 'wx', 0o600);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      if (name.startsWith('d')) await link(await this.entry(temporary), await this.entry(name));
      else await rename(await this.entry(temporary), await this.entry(name));
      await this.handle.sync();
    } finally {
      await this.entry(temporary)
        .then(unlink)
        .catch(() => {});
    }
  }
  async close() {
    try {
      if (this.release) await this.release();
    } finally {
      await this.handle.close();
    }
  }
}
