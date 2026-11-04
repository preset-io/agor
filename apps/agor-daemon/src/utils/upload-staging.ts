import { join } from 'node:path';
import {
  type AgorConfig,
  expandHomePath,
  getAgorHome,
  getManagedStorageSegments,
} from '@agor/core/config';
import { AGOR_PACK, type UploadStagingStore } from '@agor/core/types';
import { LocalUploadStagingStore } from '../host/local/upload-staging-store.js';
import { MetadataUploadStagingStore } from './metadata-upload-staging-store.js';
import { parseS3UploadLocation, S3UploadStagingStore } from './s3-upload-staging-store.js';
import { configureUploadLimits, getUploadDirectory } from './upload.js';

export type UploadStagingStoreFactory = () => UploadStagingStore;
export type S3UploadStagingStoreFactory = (location: URL, config: AgorConfig) => UploadStagingStore;

/** Resolve Agor's managed upload namespace below a local storage base. */
export function resolveLocalUploadDirectory(
  baseLocation: string,
  tenantId: string,
  tenantSeparated: boolean
): string {
  return join(baseLocation, ...getManagedStorageSegments('uploads', { tenantId, tenantSeparated }));
}

let factory: UploadStagingStoreFactory = () =>
  new LocalUploadStagingStore((tenantId) => getUploadDirectory(tenantId));
let instance: UploadStagingStore | undefined;

/**
 * `.agorpack` files and executor pack fragments are staged as raw bytes in the
 * same object store as uploads, under their own `agor-packs` namespace, with
 * the pack size limit and a short TTL. They have no `uploads` row: the owner
 * binding is (tenant, import/export id, branch-or-id, user), which the pack
 * routes re-check on every read.
 */
const PACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let packFactory: UploadStagingStoreFactory = () =>
  new LocalUploadStagingStore((tenantId) => join(getUploadDirectory(tenantId), 'agor-packs'), {
    maxBytes: AGOR_PACK.maxBytes,
    ttlMs: PACK_TTL_MS,
  });
let packInstance: UploadStagingStore | undefined;

export function getAgorPackStagingStore(): UploadStagingStore {
  packInstance ??= packFactory();
  return packInstance;
}

/** Application composition seam used by local self-hosted and Cloud adapters. */
export function configureUploadStagingStore(next: UploadStagingStoreFactory): void {
  factory = next;
  instance = undefined;
}

/**
 * Select the process-wide adapter from operator configuration. S3 construction
 * is injected by the Cloud composition root so core/daemon code never owns
 * provider credentials or a concrete object-store SDK.
 */
export function configureUploadStagingStoreFromConfig(
  config: AgorConfig,
  s3Factory?: S3UploadStagingStoreFactory,
  db?: ConstructorParameters<typeof MetadataUploadStagingStore>[0]
): void {
  const location = config.uploads?.location ?? getAgorHome();
  const maxBytes = (config.uploads?.max_file_size_mb ?? 50) * 1024 * 1024;
  configureUploadLimits(maxBytes);
  const ttlMs = (config.uploads?.max_age_days ?? 30) * 24 * 60 * 60 * 1000;
  if (/^s3:/i.test(location)) {
    configureUploadStagingStore(() => {
      const url = new URL(location);
      const adapter = s3Factory
        ? s3Factory(url, config)
        : new S3UploadStagingStore(parseS3UploadLocation(url), { maxBytes, ttlMs });
      return db ? new MetadataUploadStagingStore(db, adapter) : adapter;
    });
    packFactory = () => {
      const url = new URL(location);
      url.pathname = `${url.pathname.replace(/\/$/, '')}/agor-packs`;
      // Same injected adapter as uploads (Cloud owns S3 construction), with
      // the pack size and TTL limits instead of the upload ones.
      return s3Factory
        ? s3Factory(url, {
            ...config,
            uploads: {
              ...config.uploads,
              max_file_size_mb: AGOR_PACK.maxBytes / (1024 * 1024),
              max_age_days: PACK_TTL_MS / (24 * 60 * 60 * 1000),
            },
          })
        : new S3UploadStagingStore(parseS3UploadLocation(url), {
            maxBytes: AGOR_PACK.maxBytes,
            ttlMs: PACK_TTL_MS,
          });
    };
    packInstance = undefined;
    return;
  }
  const expanded = expandHomePath(location);
  const tenantSeparated =
    config.multi_tenancy?.filesystem_isolation_enabled === true ||
    config.multi_tenancy?.mode === 'required_from_auth';
  configureUploadStagingStore(() => {
    const adapter = new LocalUploadStagingStore(
      (tenantId) => resolveLocalUploadDirectory(expanded, tenantId, tenantSeparated),
      { maxBytes, ttlMs }
    );
    return db ? new MetadataUploadStagingStore(db, adapter) : adapter;
  });
  packFactory = () =>
    new LocalUploadStagingStore(
      (tenantId) =>
        join(resolveLocalUploadDirectory(expanded, tenantId, tenantSeparated), 'agor-packs'),
      { maxBytes: AGOR_PACK.maxBytes, ttlMs: PACK_TTL_MS }
    );
  packInstance = undefined;
}

export function getUploadStagingStore(): UploadStagingStore {
  instance ??= factory();
  return instance;
}

export function resetUploadStagingStoreForTests(): void {
  configureUploadLimits(50 * 1024 * 1024);
  factory = () => new LocalUploadStagingStore((tenantId) => getUploadDirectory(tenantId));
  instance = undefined;
  packFactory = () =>
    new LocalUploadStagingStore((tenantId) => join(getUploadDirectory(tenantId), 'agor-packs'), {
      maxBytes: AGOR_PACK.maxBytes,
      ttlMs: PACK_TTL_MS,
    });
  packInstance = undefined;
}
