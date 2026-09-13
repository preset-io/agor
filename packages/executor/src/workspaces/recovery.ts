import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { hash } from '@agor/core/workspaces';
import type { WorkspaceBlobs, WorkspaceScope } from '@agor/core/workspaces/types';
import { z } from 'zod';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Slice = z.object({
  hash: Digest,
  offset: z.number().int().nonnegative(),
  length: z
    .number()
    .int()
    .positive()
    .max(32 * 1024 ** 2),
});
const Item = z.object({
  path: z.string(),
  mode: z.number().int().min(0).max(4095),
  mtimeMs: z.number().finite().optional(),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  kind: z.enum(['directory', 'file', 'symlink']),
  parts: z.array(z.union([Digest, Slice])).default([]),
  target: z.string().optional(),
});
const Manifest = z.object({
  schema: z.union([z.literal(1), z.literal(2)]),
  tenantId: z.string(),
  branchId: z.string(),
  entries: z.array(Item).max(1000000),
});
const PACK_BYTES = 32 * 1024 ** 2;
const TRANSFERS = 8;
/** Wait for every in-flight operation before cleanup, including on failure. */
async function parallel<T>(items: T[], work: (item: T) => Promise<void>) {
  let cursor = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(TRANSFERS, items.length) }, async () => {
      while (!failure && cursor < items.length) {
        const item = items[cursor++];
        try {
          await work(item);
        } catch (error) {
          failure = error;
        }
      }
    })
  );
  if (failure) throw failure;
}
export interface SnapshotOptions {
  signal?: AbortSignal;
  /** Trusted controller directory, scoped by bucket + tenant + branch; never an SDK mount.
   * Receipts are written only after immutable S3 acknowledgments, and survive failed runs. */
  journal?: string;
}
/** v2 packs small files together. Hash-sharded sorted paths keep unrelated packs stable
 * across edits. v1 remains readable. No archive interpreter or symlink traversal. */
export async function snapshotReplicas(
  root: string,
  scope: WorkspaceScope,
  blobs: WorkspaceBlobs,
  options: SnapshotOptions = {}
): Promise<string> {
  const { signal, journal } = options;
  const entries: z.infer<typeof Item>[] = [];
  const files: { item: z.infer<typeof Item>; size: number; ino: number; mtimeMs: number }[][] =
    Array.from({ length: 64 }, () => []);
  const acknowledged = new Set<string>();
  if (journal) {
    await mkdir(journal, { recursive: true, mode: 0o700 });
    for (const name of await readdir(journal))
      if (/^[a-f0-9]{64}$/.test(name)) acknowledged.add(name);
  }
  async function put(digest: string, bytes: Buffer) {
    signal?.throwIfAborted();
    if (acknowledged.has(digest)) return;
    await blobs.put(digest, bytes);
    if (journal) await writeFile(path.join(journal, digest), '', { mode: 0o600 });
    acknowledged.add(digest);
  }
  async function visit(relative: string) {
    signal?.throwIfAborted();
    const st = await lstat(path.join(root, relative));
    const item: z.infer<typeof Item> = {
      path: relative,
      mode: st.mode & 0o777,
      mtimeMs: st.mtimeMs,
      uid: st.uid,
      gid: st.gid,
      kind: 'file',
      parts: [],
    };
    if (st.isSymbolicLink()) {
      item.kind = 'symlink';
      item.target = await readlink(path.join(root, relative));
    } else if (st.isDirectory()) item.kind = 'directory';
    else if (st.isFile())
      files[parseInt(hash(Buffer.from(relative)).slice(0, 2), 16) % 64].push({
        item,
        size: st.size,
        ino: st.ino,
        mtimeMs: st.mtimeMs,
      });
    else throw new Error('Special file prevents workspace eviction');
    entries.push(item);
    if (entries.length > 1000000) throw new Error('Recovery manifest entry limit exceeded');
    if (item.kind === 'directory')
      for (const name of (await readdir(path.join(root, relative))).sort())
        await visit(path.join(relative, name));
  }
  // Traverse once before allocating pack buffers. At most eight 32 MiB packs are active.
  for (const name of (await readdir(root)).sort()) await visit(name);
  await parallel(files, async (bucket) => {
    if (!bucket.length) return;
    const buffer = Buffer.allocUnsafe(PACK_BYTES);
    let used = 0;
    let references: { item: z.infer<typeof Item>; offset: number; length: number }[] = [];
    async function flush() {
      if (!used) return;
      const bytes = buffer.subarray(0, used),
        digest = hash(bytes);
      await put(digest, bytes);
      for (const r of references)
        r.item.parts.push({ hash: digest, offset: r.offset, length: r.length });
      references = [];
      used = 0;
    }
    for (const { item, size, ino, mtimeMs } of bucket) {
      signal?.throwIfAborted();
      const fd = await open(path.join(root, item.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        let total = 0;
        for (;;) {
          if (used === PACK_BYTES) await flush();
          const { bytesRead } = await fd.read(buffer, used, PACK_BYTES - used, null);
          if (!bytesRead) break;
          references.push({ item, offset: used, length: bytesRead });
          used += bytesRead;
          total += bytesRead;
        }
        const after = await fd.stat();
        if (total !== size || after.size !== size || after.mtimeMs !== mtimeMs || after.ino !== ino)
          throw new Error('Recovery source changed');
      } finally {
        await fd.close();
      }
    }
    await flush();
  });
  signal?.throwIfAborted();
  const manifest = Buffer.from(JSON.stringify({ schema: 2, ...scope, entries }));
  if (manifest.length > 64 * 1024 ** 2) throw new Error('Recovery manifest too large');
  const digest = hash(manifest);
  await put(digest, manifest);
  return digest;
}
export async function restoreReplicas(
  root: string,
  scope: WorkspaceScope,
  digest: string,
  blobs: WorkspaceBlobs,
  sessionId?: string,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const bytes = await blobs.get(digest);
  signal?.throwIfAborted();
  if (bytes.length > 64 * 1024 ** 2) throw new Error('Recovery manifest too large');
  if (hash(bytes) !== digest) throw new Error('Recovery manifest checksum mismatch');
  const manifest = Manifest.parse(JSON.parse(bytes.toString()));
  if (manifest.tenantId !== scope.tenantId || manifest.branchId !== scope.branchId)
    throw new Error('Recovery scope mismatch');
  if (sessionId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid recovery session');
    manifest.entries = manifest.entries.filter(
      (e) => e.path === sessionId || e.path.startsWith(`${sessionId}/`)
    );
    if (!manifest.entries.length) return;
  }
  const kinds = new Map<string, string>();
  for (const item of manifest.entries) {
    if (
      !item.path ||
      path.isAbsolute(item.path) ||
      item.path.split('/').some((p) => !p || p === '.' || p === '..') ||
      item.path.includes('\\') ||
      kinds.has(item.path)
    )
      throw new Error('Unsafe recovery path');
    kinds.set(item.path, item.kind);
  }
  for (const item of manifest.entries) {
    for (let parent = path.dirname(item.path); parent !== '.'; parent = path.dirname(parent))
      if (kinds.get(parent) !== 'directory')
        throw new Error('Recovery path has non-directory ancestor');
    if (item.kind === 'symlink' && item.target === undefined)
      throw new Error('Missing symlink target');
  }
  const temp = `${root}.restore-${randomUUID()}`;
  await mkdir(temp, { recursive: true, mode: 0o700 });
  try {
    const packs = new Map<
      string,
      { file: string; offset: number; length?: number; position: number }[]
    >();
    // Create safe ancestors and empty files before parallel positioned writes.
    for (const item of [...manifest.entries].sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length
    )) {
      signal?.throwIfAborted();
      const file = path.join(temp, item.path);
      if (item.kind === 'directory') await mkdir(file, { mode: 0o700 });
      else if (item.kind === 'symlink') await symlink(item.target!, file);
      else {
        const fd = await open(file, 'wx', 0o600);
        await fd.close();
        let position = 0;
        for (const part of item.parts) {
          if (manifest.schema === 1) {
            if (typeof part !== 'string') throw new Error('Invalid legacy recovery part');
            // v1 files have variable-size sequential chunks; restore each file separately below.
          } else {
            if (typeof part === 'string') throw new Error('Invalid packed recovery part');
            const list = packs.get(part.hash) ?? [];
            list.push({ file, offset: part.offset, length: part.length, position });
            packs.set(part.hash, list);
            position += part.length;
            if (!Number.isSafeInteger(position)) throw new Error('Recovery file too large');
          }
        }
      }
    }
    if (manifest.schema === 1) {
      await parallel(
        manifest.entries.filter((i) => i.kind === 'file'),
        async (item) => {
          const fd = await open(path.join(temp, item.path), 'r+');
          try {
            for (const part of item.parts) {
              signal?.throwIfAborted();
              const content = await blobs.get(part as string);
              signal?.throwIfAborted();
              if (hash(content) !== part) throw new Error('Recovery part checksum mismatch');
              await fd.writeFile(content);
            }
          } finally {
            await fd.close();
          }
        }
      );
    } else {
      await parallel([...packs], async ([digest, slices]) => {
        signal?.throwIfAborted();
        const bytes = await blobs.get(digest);
        signal?.throwIfAborted();
        if (bytes.length > PACK_BYTES || hash(bytes) !== digest)
          throw new Error('Recovery pack checksum mismatch');
        for (const slice of slices) {
          signal?.throwIfAborted();
          if (slice.offset + slice.length! > bytes.length)
            throw new Error('Recovery slice outside pack');
          const fd = await open(slice.file, 'r+');
          try {
            let written = 0;
            while (written < slice.length!) {
              const { bytesWritten } = await fd.write(
                bytes,
                slice.offset + written,
                slice.length! - written,
                slice.position + written
              );
              if (!bytesWritten) throw new Error('Recovery write made no progress');
              written += bytesWritten;
            }
          } finally {
            await fd.close();
          }
        }
      });
    }
    // Apply restrictive directory modes after their children have been populated.
    for (const item of [...manifest.entries].reverse())
      if (item.kind !== 'symlink') {
        signal?.throwIfAborted();
        const file = path.join(temp, item.path);
        if (process.getuid?.() === 0) await chown(file, item.uid, item.gid);
        await chmod(file, item.mode);
        if (item.mtimeMs !== undefined)
          await utimes(file, item.mtimeMs / 1000, item.mtimeMs / 1000);
      }
    signal?.throwIfAborted();
    if (sessionId) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await rename(path.join(temp, sessionId), path.join(root, sessionId));
    } else await rename(temp, root);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
