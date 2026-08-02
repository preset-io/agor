import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  TenantID,
  UploadMetadata,
  UploadOwner,
  UploadReadInput,
  UploadRef,
  UploadStageInput,
  UploadStagingStore,
} from '@agor/core/types';

export const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

type StoredMetadata = UploadMetadata & {
  tenantId: TenantID;
  sessionId: string;
  branchId: string;
  createdBy: string;
};

function safeName(value: string): string {
  const clean = basename(value)
    .replace(/\.\./g, '_')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 200);
  return clean || 'upload';
}

function forbidden(message = 'Upload not found'): Error {
  return Object.assign(new Error(message), { status: 404 });
}

export class LocalUploadStagingStore implements UploadStagingStore {
  constructor(
    private readonly rootForTenant: (tenantId: string) => string,
    private readonly options: { maxBytes?: number; ttlMs?: number } = {}
  ) {
    const maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
    const ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error('Invalid upload maxBytes');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error('Invalid upload ttlMs');
  }

  private paths(owner: Pick<UploadOwner, 'tenantId'>, ref: UploadRef) {
    if (!/^upl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref))
      throw forbidden();
    const root = resolve(this.rootForTenant(owner.tenantId));
    const dir = join(root, 'objects', ref.slice(4, 6));
    return { root, dir, data: join(dir, `${ref}.data`), meta: join(dir, `${ref}.json`) };
  }

  private async load(input: UploadReadInput): Promise<{ stored: StoredMetadata; data: string }> {
    const paths = this.paths(input, input.ref);
    let stored: StoredMetadata;
    try {
      stored = JSON.parse(await readFile(paths.meta, 'utf8')) as StoredMetadata;
      const dataStat = await lstat(paths.data);
      if (!dataStat.isFile() || dataStat.isSymbolicLink()) throw forbidden();
    } catch {
      throw forbidden();
    }
    if (
      stored.tenantId !== input.tenantId ||
      stored.sessionId !== input.sessionId ||
      stored.branchId !== input.branchId
    ) {
      throw forbidden();
    }
    if (stored.expiresAt !== null && Date.parse(stored.expiresAt) <= Date.now()) {
      await Promise.allSettled([rm(paths.data), rm(paths.meta)]);
      throw Object.assign(new Error('Upload has expired'), { status: 410 });
    }
    return { stored, data: paths.data };
  }

  async stage(input: UploadStageInput): Promise<UploadMetadata> {
    const maxBytes = this.options.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
    const ttlMs = input.ttlMs ?? this.options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error('Invalid upload ttlMs');
    if (input.sizeHint !== undefined && input.sizeHint > maxBytes) {
      throw Object.assign(new Error(`Upload exceeds ${maxBytes}-byte limit`), { status: 413 });
    }
    const ref = `upl_${randomUUID()}` as UploadRef;
    const paths = this.paths(input.owner, ref);
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    const temporary = `${paths.data}.${randomUUID()}.partial`;
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          callback(
            Object.assign(new Error(`Upload exceeds ${maxBytes}-byte limit`), { status: 413 })
          );
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        input.body,
        limiter,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
      );
      await rename(temporary, paths.data);
      const now = new Date();
      const metadata: StoredMetadata = {
        ref,
        name: safeName(input.name),
        mimeType: input.mimeType,
        size,
        createdAt: now.toISOString(),
        expiresAt: ttlMs === 0 ? null : new Date(now.getTime() + ttlMs).toISOString(),
        provenance: input.provenance,
        tenantId: input.owner.tenantId,
        sessionId: input.owner.sessionId,
        branchId: input.owner.branchId,
        createdBy: input.owner.createdBy,
      };
      await writeFile(paths.meta, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      const {
        tenantId: _tenant,
        sessionId: _session,
        branchId: _branch,
        createdBy: _creator,
        ...logical
      } = metadata;
      return logical;
    } catch (error) {
      await Promise.allSettled([rm(temporary), rm(paths.data), rm(paths.meta)]);
      throw error;
    }
  }

  async inspect(input: UploadReadInput): Promise<UploadMetadata> {
    const { stored } = await this.load(input);
    const {
      tenantId: _tenant,
      sessionId: _session,
      branchId: _branch,
      createdBy: _creator,
      ...logical
    } = stored;
    return logical;
  }

  async read(
    input: UploadReadInput & { offset?: number; length?: number }
  ): Promise<NodeJS.ReadableStream> {
    const { data } = await this.load(input);
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid upload read offset');
    if (input.length !== undefined && (!Number.isSafeInteger(input.length) || input.length <= 0)) {
      throw new Error('Invalid upload read length');
    }
    return createReadStream(data, {
      start: offset,
      ...(input.length !== undefined ? { end: offset + input.length - 1 } : {}),
    });
  }

  async consume(input: UploadReadInput): Promise<void> {
    // Ephemeral consume means remove the canonical bytes. `delete` verifies
    // exact ownership and is retry-safe when a previous attempt completed.
    await this.delete(input);
  }

  async delete(input: UploadReadInput): Promise<void> {
    const paths = this.paths(input, input.ref);
    try {
      const stored = JSON.parse(await readFile(paths.meta, 'utf8')) as StoredMetadata;
      if (
        stored.tenantId !== input.tenantId ||
        stored.sessionId !== input.sessionId ||
        stored.branchId !== input.branchId
      ) {
        throw forbidden();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all([rm(paths.data, { force: true }), rm(paths.meta, { force: true })]);
  }

  async cleanupExpired(owner: Pick<UploadOwner, 'tenantId'>, now = new Date()): Promise<number> {
    const root = resolve(this.rootForTenant(owner.tenantId));
    const objectRoot = join(root, 'objects');
    let removed = 0;
    for (const bucket of await readdir(objectRoot).catch(() => [])) {
      const bucketPath = join(objectRoot, bucket);
      const entries = await readdir(bucketPath).catch(() => []);
      const names = new Set(entries);
      for (const entry of entries) {
        const entryPath = join(bucketPath, entry);
        if (entry.includes('.partial')) {
          const age = now.getTime() - (await stat(entryPath)).mtimeMs;
          if (age >= (this.options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS)) {
            await rm(entryPath, { force: true });
            removed++;
          }
          continue;
        }
        if (entry.endsWith('.data') && !names.has(entry.replace(/\.data$/, '.json'))) {
          const age = now.getTime() - (await stat(entryPath)).mtimeMs;
          if (age >= (this.options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS)) {
            await rm(entryPath, { force: true });
            removed++;
          }
          continue;
        }
        if (!entry.endsWith('.json')) continue;
        const metaPath = join(bucketPath, entry);
        try {
          const metadata = JSON.parse(await readFile(metaPath, 'utf8')) as StoredMetadata;
          if (
            metadata.tenantId !== owner.tenantId ||
            metadata.expiresAt === null ||
            Date.parse(metadata.expiresAt) > now.getTime()
          ) {
            continue;
          }
          const dataPath = join(bucketPath, entry.replace(/\.json$/, '.data'));
          await Promise.all([rm(metaPath, { force: true }), rm(dataPath, { force: true })]);
          removed++;
        } catch {
          const age = now.getTime() - (await stat(metaPath)).mtimeMs;
          if (age >= (this.options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS)) {
            await Promise.all([
              rm(metaPath, { force: true }),
              rm(join(bucketPath, entry.replace(/\.json$/, '.data')), { force: true }),
            ]);
            removed++;
          }
        }
      }
    }
    return removed;
  }
}
