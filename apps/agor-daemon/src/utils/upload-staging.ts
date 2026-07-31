import { join } from 'node:path';
import { type AgorConfig, expandHomePath } from '@agor/core/config';
import type { UploadStagingStore } from '@agor/core/types';
import { MetadataUploadStagingStore } from './metadata-upload-staging-store.js';
import { configureUploadLimits, getUploadDirectory } from './upload.js';
import { LocalUploadStagingStore } from './upload-staging-store.js';

export type UploadStagingStoreFactory = () => UploadStagingStore;
export type S3UploadStagingStoreFactory = (location: URL, config: AgorConfig) => UploadStagingStore;

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
  const location = config.uploads?.location ?? '~/.agor/uploads';
  const maxBytes = (config.uploads?.max_file_size_mb ?? 50) * 1024 * 1024;
  configureUploadLimits(maxBytes);
  const ttlMs = (config.uploads?.max_age_days ?? 30) * 24 * 60 * 60 * 1000;
  if (location.startsWith('s3://')) {
    if (!s3Factory) {
      throw new Error(
        'uploads.location uses s3:// but no Cloud UploadStagingStore adapter is configured'
      );
    }
    configureUploadStagingStore(() => {
      const adapter = s3Factory(new URL(location), config);
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
      (tenantId) => (tenantSeparated ? join(expanded, tenantId) : expanded),
      { maxBytes, ttlMs }
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
