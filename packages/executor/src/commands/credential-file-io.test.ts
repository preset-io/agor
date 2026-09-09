import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Ordered record of the durability-relevant syscalls the writer makes. */
const trace: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async open(path: string, flags: string, mode?: number) {
      const handle = await actual.open(path, flags, mode);
      const kind = (await handle.stat()).isDirectory() ? 'dir' : 'file';
      return {
        // The production writer walks directories through /proc/self/fd so
        // the mock must preserve the capability-bearing descriptor. Omitting
        // it silently redirects the walk through /proc/self/fd/undefined.
        fd: handle.fd,
        writeFile: (content: string, encoding: BufferEncoding) => {
          trace.push(`write:${kind}`);
          return handle.writeFile(content, encoding);
        },
        chmod: (m: number) => handle.chmod(m),
        readFile: (encoding: BufferEncoding) => handle.readFile(encoding),
        sync: () => {
          trace.push(`sync:${kind}`);
          return handle.sync();
        },
        close: () => handle.close(),
      };
    },
    async rename(from: string, to: string) {
      trace.push('rename');
      return actual.rename(from, to);
    },
  };
});

const { writeCredentialFileAtomically } = await import('./credential-file-io.js');

let dir: string;
beforeEach(async () => {
  trace.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'agor-credential-io-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeCredentialFileAtomically', () => {
  it('fsyncs the bytes before the rename and the directory after it', async () => {
    const target = join(dir, '.credentials.json');

    await writeCredentialFileAtomically(target, 'credential-bytes');

    // The file's bytes must be on stable storage BEFORE the rename publishes
    // the path, and the directory entry must be flushed after — otherwise a
    // node lost here comes back with a missing or truncated credential that the
    // daemon has already reported as a successful sign-in.
    expect(trace).toEqual(['write:file', 'sync:file', 'rename', 'sync:dir']);
  });

  it('still lands 0600 content atomically with no leftover temp file', async () => {
    const target = join(dir, '.credentials.json');

    expect(await writeCredentialFileAtomically(target, 'first')).toBe('first');
    expect(await writeCredentialFileAtomically(target, 'second')).toBe('second');

    expect(await readFile(target, 'utf8')).toBe('second');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['.credentials.json']);
  });

  it('removes the temp file when the rename fails', async () => {
    // A directory at the target path makes rename fail after the temp file was
    // written and synced; the temp must not be left behind holding credentials.
    const target = join(dir, 'occupied');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target);
    await mkdir(join(target, 'child'));

    await expect(writeCredentialFileAtomically(target, 'credential-bytes')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['occupied']);
  });
});
