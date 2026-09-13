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
} from 'node:fs/promises';
import path from 'node:path';
import { hash } from '@agor/core/workspaces';
import type { WorkspaceBlobs, WorkspaceScope } from '@agor/core/workspaces/types';
import { z } from 'zod';

const Item = z.object({
  path: z.string(),
  mode: z.number().int().min(0).max(4095),
  mtimeMs: z.number().finite().optional(),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  kind: z.enum(['directory', 'file', 'symlink']),
  parts: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
  target: z.string().optional(),
});
const Manifest = z.object({
  schema: z.literal(1),
  tenantId: z.string(),
  branchId: z.string(),
  entries: z.array(Item).max(1000000),
});
/** Private recovery includes Git indexes/refs, homes and excluded files, not just committed source.
 * No archive interpreter or symlink traversal. Unsupported special files pin the generation.
 */
export async function snapshotReplicas(
  root: string,
  scope: WorkspaceScope,
  blobs: WorkspaceBlobs
): Promise<string> {
  const entries: z.infer<typeof Item>[] = [];
  async function visit(relative: string) {
    const file = path.join(root, relative);
    const st = await lstat(file);
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
      item.target = await readlink(file);
    } else if (st.isDirectory()) item.kind = 'directory';
    else if (st.isFile()) {
      const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.allocUnsafe(16 * 1024 ** 2);
        for (;;) {
          const { bytesRead } = await fd.read(bytes, 0, bytes.length, null);
          if (!bytesRead) break;
          const chunk = bytes.subarray(0, bytesRead),
            digest = hash(chunk);
          await blobs.put(digest, chunk);
          item.parts.push(digest);
        }
        const after = await fd.stat();
        if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ino !== st.ino)
          throw new Error('Recovery source changed');
      } finally {
        await fd.close();
      }
    } else throw new Error('Special file prevents workspace eviction');
    entries.push(item);
    if (entries.length > 1000000) throw new Error('Recovery manifest entry limit exceeded');
    if (item.kind === 'directory')
      for (const name of await readdir(file)) await visit(path.join(relative, name));
  }
  try {
    for (const name of await readdir(root)) await visit(name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    else throw new Error('Replica disappeared during snapshot');
  }
  const manifest = Buffer.from(JSON.stringify({ schema: 1, ...scope, entries }));
  if (manifest.length > 64 * 1024 ** 2) throw new Error('Recovery manifest too large');
  const digest = hash(manifest);
  await blobs.put(digest, manifest);
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
    for (const item of [...manifest.entries].sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length
    )) {
      signal?.throwIfAborted();
      const file = path.join(temp, item.path);
      if (item.kind === 'directory') await mkdir(file, { mode: 0o700 });
      else if (item.kind === 'symlink') await symlink(item.target!, file);
      else {
        const fd = await open(file, 'wx', 0o600);
        try {
          for (const part of item.parts) {
            signal?.throwIfAborted();
            const content = await blobs.get(part);
            signal?.throwIfAborted();
            if (hash(content) !== part) throw new Error('Recovery part checksum mismatch');
            await fd.writeFile(content);
          }
        } finally {
          await fd.close();
        }
      }
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
