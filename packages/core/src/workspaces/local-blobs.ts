import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { getManagedStorageSegments } from '../config/storage-layout';
import type { TenantID } from '../types';
import { hash } from './tree';
import type { WorkspaceBlobs } from './types';
import { WorkspaceError } from './types';

/** Local durable-object emulator for integration tests and single-host development. Not HA storage. */
export class LocalWorkspaceBlobs implements WorkspaceBlobs {
  readonly directory: string;
  constructor(root: string, tenantId: TenantID) {
    this.directory = path.join(
      root,
      ...getManagedStorageSegments('workspace-blobs', { tenantId, tenantSeparated: true })
    );
  }
  private file(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new WorkspaceError('INVALID', 'Invalid blob key');
    return path.join(this.directory, key);
  }
  async put(key: string, content: Buffer): Promise<void> {
    if (hash(content) !== key) throw new WorkspaceError('CORRUPT', 'Blob checksum mismatch');
    const target = this.file(key);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const existing = await this.get(key);
      if (hash(existing) !== key) throw new WorkspaceError('CORRUPT', 'Existing blob corrupt');
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const temp = `${target}.${randomUUID()}`;
    try {
      await writeFile(temp, gzipSync(content), { flag: 'wx', mode: 0o600 });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async get(key: string): Promise<Buffer> {
    const content = gunzipSync(await readFile(this.file(key)), {
      maxOutputLength: 128 * 1024 * 1024,
    });
    if (hash(content) !== key) throw new WorkspaceError('CORRUPT', 'Blob checksum mismatch');
    return content;
  }
}
