import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { transferSha256 } from '@agor/core/knowledge';
import { KNOWLEDGE_REPOSITORY, KNOWLEDGE_TRANSFER, normalizeKnowledgePath } from '@agor/core/types';
import { lock } from 'proper-lockfile';
import { assertKnowledgeDirectorySupported } from './directory';

/** Nested private working tree. Linux operations are anchored to pinned directory
 * descriptors; portable reads prove canonical inode identity before and after I/O.
 * Like the existing bundle owner, this is not an isolation boundary against the
 * CLI's own uid. Writable directories must be private to that uid.
 */
export class RepositoryDirectory {
  private release?: () => Promise<void>;
  private locked = false;
  private constructor(
    private root: FileHandle,
    readonly path: string,
    private writable: boolean
  ) {}

  static async open(path: string, writable = false) {
    assertKnowledgeDirectorySupported();
    const absolute = resolve(path);
    if (writable)
      await mkdir(absolute, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const root = await open(
      absolute,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      const directory = new RepositoryDirectory(root, await realpath(absolute), writable);
      await directory.check(root, directory.path);
      return directory;
    } catch (error) {
      await root.close();
      throw error;
    }
  }

  private async check(handle: FileHandle, path: string) {
    const info = await handle.stat();
    let canonical: string;
    if (process.platform === 'linux') canonical = await readlink(`/proc/self/fd/${handle.fd}`);
    else canonical = await realpath(path);
    const rel = relative(this.path, canonical);
    if (
      isAbsolute(rel) ||
      rel === '..' ||
      rel.startsWith('../') ||
      canonical.endsWith(' (deleted)')
    )
      throw new Error('Repository path escaped its root');
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino)
      throw new Error('Repository path changed during access');
    if (
      this.writable &&
      info.isDirectory() &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    )
      throw new Error('Export directories must be owned by you and private (mode 0700)');
  }

  private components(name: string) {
    if (
      normalizeKnowledgePath(name) !== name ||
      name.split('/').some((p) => p.toLowerCase() === '.git')
    )
      throw new Error('Unsafe repository path');
    return name.split('/');
  }

  async withDirectory<T>(
    name: string,
    create: boolean,
    operation: (path: string) => Promise<T>
  ): Promise<T> {
    const handles: Array<{ handle: FileHandle; path: string }> = [
      { handle: this.root, path: this.path },
    ];
    try {
      for (const component of name ? this.components(name) : []) {
        const parent = handles.at(-1)!;
        await this.check(parent.handle, parent.path);
        const path = join(
          process.platform === 'linux' ? `/proc/self/fd/${parent.handle.fd}` : parent.path,
          component
        );
        if (create)
          await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        handles.push({ handle, path });
        await this.check(handle, path);
      }
      const leaf = handles.at(-1)!;
      const result = await operation(
        process.platform === 'linux' ? `/proc/self/fd/${leaf.handle.fd}` : leaf.path
      );
      for (const item of handles) await this.check(item.handle, item.path);
      return result;
    } finally {
      for (const { handle } of handles.slice(1).reverse()) await handle.close();
    }
  }

  async read(name: string, limit: number): Promise<string | null> {
    const parts = this.components(name);
    const base = parts.pop()!;
    try {
      return await this.withDirectory(parts.join('/'), false, async (parent) => {
        const path = join(parent, base);
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
          const info = await file.stat();
          await this.check(file, path);
          if (!info.isFile() || info.nlink !== 1 || info.size > limit)
            throw new Error('Unsafe or oversized repository file');
          const chunks: Buffer[] = [];
          let length = 0;
          while (true) {
            const buffer = Buffer.alloc(Math.min(65536, limit + 1 - length));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            length += bytesRead;
            if (length > limit) throw new Error('Repository file exceeds byte limit');
            chunks.push(buffer.subarray(0, bytesRead));
          }
          await this.check(file, path);
          return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            Buffer.concat(chunks)
          );
        } finally {
          await file.close();
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(name: string, content: string, expected?: string | null) {
    if (!this.locked || !this.writable) throw new Error('Repository write requires exclusive lock');
    const parts = this.components(name);
    const base = parts.pop()!;
    await this.withDirectory(parts.join('/'), true, async (parent) => {
      const path = join(parent, base);
      const temporary = join(parent, `.tmp-${randomUUID()}`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        await this.check(file, temporary);
        await file.writeFile(content, 'utf8');
        await file.sync();
        await this.check(file, temporary);
        if (!this.locked) throw new Error('Repository lock lost');
        const prior = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (prior && (!prior.isFile() || prior.nlink !== 1))
          throw new Error('Unsafe repository replacement');
        if (expected !== undefined) {
          const current = await this.read(name, KNOWLEDGE_REPOSITORY.maxFileBytes);
          if ((current === null ? null : transferSha256(current)) !== expected)
            throw new Error(
              'Local content changed immediately before publication; refusing overwrite'
            );
        }
        await rename(temporary, path);
        const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await file.close();
        await unlink(temporary).catch(() => {});
      }
    });
  }

  async lock() {
    if (!this.writable) throw new Error('Read-only repository');
    this.release = await lock(this.path, {
      realpath: false,
      lockfilePath: join(this.path, KNOWLEDGE_REPOSITORY.lock),
      stale: 30_000,
      update: 10_000,
      onCompromised: () => {
        this.locked = false;
      },
    });
    this.locked = true;
  }
  async assertComplete() {
    if (
      await lstat(join(this.path, KNOWLEDGE_REPOSITORY.lock)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        }
      )
    )
      throw new Error('Export is locked; do not import an active export');
    const pending = await this.read(
      KNOWLEDGE_REPOSITORY.pending,
      KNOWLEDGE_TRANSFER.maxManifestBytes
    );
    if (pending && pending.trim() !== 'null')
      throw new Error('Export publication incomplete; resume export before importing');
  }

  async documentFiles(): Promise<string[]> {
    const files: string[] = [];
    let count = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 64) throw new Error('Repository directory nesting limit exceeded');
      await this.withDirectory(directory, false, async (parent) => {
        for (const item of await readdir(parent, { withFileTypes: true })) {
          if (++count > KNOWLEDGE_TRANSFER.maxDocuments * 4)
            throw new Error('Repository file count limit exceeded');
          const path = `${directory}/${item.name}`;
          if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile()))
            throw new Error('Unsafe entry in docs directory');
          if (item.isDirectory()) await walk(path, depth + 1);
          else if (item.name.endsWith('.md')) files.push(path);
        }
      });
    };
    try {
      await walk('docs', 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return files.sort();
  }
  async close() {
    try {
      await this.release?.();
    } finally {
      await this.root.close();
    }
  }
}
