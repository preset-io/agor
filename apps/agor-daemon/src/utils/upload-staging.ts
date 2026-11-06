import { join } from 'node:path';
import {
  type AgorConfig,
  expandHomePath,
  getAgorHome,
  getManagedStorageSegments,
} from '@agor/core/config';
import { AGOR_PACK, type BlobStagingStore, type UploadStagingStore } from '@agor/core/types';
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
 * `.agor` files and executor pack fragments are blobs of the same upload
 * store (see `MetadataUploadStagingStore.blobs`): their own byte namespace
 * (`agor-packs`, pack size limit, short TTL), their own owner rows, and the
 * same expiry sweep as attachments.
 */
const PACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getBlobStagingStore(): BlobStagingStore {
  const store = getUploadStagingStore();
  if (!(store instanceof MetadataUploadStagingStore) || !store.blobs) {
    throw new Error('Pack staging requires the database-backed upload store');
  }
  return store.blobs;
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
      if (!db) return adapter;
      const packUrl = new URL(location);
      packUrl.pathname = `${packUrl.pathname.replace(/\/$/, '')}/agor-packs`;
      // Same injected adapter as uploads (Cloud owns S3 construction), with
      // the pack size and TTL limits instead of the upload ones.
      const packBytes = s3Factory
        ? s3Factory(packUrl, {
            ...config,
            uploads: {
              ...config.uploads,
              max_file_size_mb: AGOR_PACK.maxBytes / (1024 * 1024),
              max_age_days: PACK_TTL_MS / (24 * 60 * 60 * 1000),
            },
          })
        : new S3UploadStagingStore(parseS3UploadLocation(packUrl), {
            maxBytes: AGOR_PACK.maxBytes,
            ttlMs: PACK_TTL_MS,
          });
      // Restored attachments: the uploads namespace with the pack entry limit.
      const restoreBytes = s3Factory
        ? s3Factory(url, {
            ...config,
            uploads: {
              ...config.uploads,
              max_file_size_mb: AGOR_PACK.maxEntryBytes / (1024 * 1024),
            },
          })
        : new S3UploadStagingStore(parseS3UploadLocation(url), {
            maxBytes: AGOR_PACK.maxEntryBytes,
            ttlMs,
          });
      return new MetadataUploadStagingStore(
        db,
        adapter,
        { bytes: packBytes, ttlMs: PACK_TTL_MS },
        { bytes: restoreBytes, maxBytes: AGOR_PACK.maxEntryBytes }
      );
    });
    return;
  }
  const expanded = expandHomePath(location);
  const tenantSeparated =
    config.multi_tenancy?.filesystem_isolation_enabled === true ||
    config.multi_tenancy?.mode === 'required_from_auth';
  configureUploadStagingStore(() => {
    const root = (tenantId: string) =>
      resolveLocalUploadDirectory(expanded, tenantId, tenantSeparated);
    const adapter = new LocalUploadStagingStore(root, { maxBytes, ttlMs });
    if (!db) return adapter;
    return new MetadataUploadStagingStore(
      db,
      adapter,
      {
        bytes: localPackBytes((tenantId) => join(root(tenantId), 'agor-packs')),
        ttlMs: PACK_TTL_MS,
      },
      {
        bytes: new LocalUploadStagingStore(root, { maxBytes: AGOR_PACK.maxEntryBytes, ttlMs }),
        maxBytes: AGOR_PACK.maxEntryBytes,
      }
    );
  });
}

/** Local byte namespace for pack blobs (tests compose it the same way). */
export function localPackBytes(root: (tenantId: string) => string): UploadStagingStore {
  return new LocalUploadStagingStore(root, { maxBytes: AGOR_PACK.maxBytes, ttlMs: PACK_TTL_MS });
}

export function getUploadStagingStore(): UploadStagingStore {
  instance ??= factory();
  return instance;
}

export function resetUploadStagingStoreForTests(): void {
  configureUploadLimits(50 * 1024 * 1024);
  factory = () => new LocalUploadStagingStore((tenantId) => getUploadDirectory(tenantId));
  instance = undefined;
}
