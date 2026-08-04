import { join } from 'node:path';
import { type AgorConfig, expandHomePath, getManagedStorageSegments } from '@agor/core/config';
import type { UploadStagingStore } from '@agor/core/types';
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
  const location = config.uploads?.location ?? '~/.agor';
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
    return;
  }
  const expanded = expandHomePath(location);
  const tenantSeparated =
    config.multi_tenancy?.filesystem_isolation_enabled === true ||
    config.multi_tenancy?.mode === 'required_from_auth';
  configureUploadStagingStore(() => {
    const adapter = new LocalUploadStagingStore(
      (tenantId) => resolveLocalUploadDirectory(expanded, tenantId, tenantSeparated),
      { maxBytes, ttlMs, directWrite: config.uploads?.direct_write === true }
    );
    return db ? new MetadataUploadStagingStore(db, adapter) : adapter;
  });
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
