import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lock } from 'proper-lockfile';

/** Flat, manifest-addressed bundle files. Directory FD pins the root against swaps. */
export class KnowledgeDirectory {
  private constructor(
    private handle: FileHandle,
    readonly path: string,
    private writable: boolean
  ) {}
  private locked = false;
  private release: (() => Promise<void>) | undefined;
  static async open(path: string, writable = false): Promise<KnowledgeDirectory> {
    if (process.platform !== 'linux')
      throw new Error('Safe Knowledge directory transfers currently require Linux');
    const absolute = resolve(path);
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
    return new KnowledgeDirectory(handle, absolute, writable);
  }
  private entry(name: string) {
    if (
      !/^(?:d[0-9]{6}(?:-[a-f0-9]{64})?\.md|manifest\.json|checkpoint\.json|\.lock|\.tmp-[a-f0-9-]+)$/.test(
        name
      )
    )
      throw new Error('Unsafe bundle filename');
    return `/proc/self/fd/${this.handle.fd}/${name}`;
  }
  async lock() {
    if (!this.writable) throw new Error('Read-only bundle');
    this.release = await lock(`/proc/self/fd/${this.handle.fd}`, {
      realpath: false,
      lockfilePath: this.entry('.lock'),
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
      await lstat(this.entry('.lock'));
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
        this.entry(name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
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
    const file = await open(this.entry(temporary), 'wx', 0o600);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      if (name.startsWith('d')) await link(this.entry(temporary), this.entry(name));
      else await rename(this.entry(temporary), this.entry(name));
      await this.handle.sync();
    } finally {
      await unlink(this.entry(temporary)).catch(() => {});
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
