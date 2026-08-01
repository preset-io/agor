import type { AgorConfig } from '@agor/core/config';
import type { UploadStagingStore } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { S3UploadStagingStore } from './s3-upload-staging-store.js';
import { getUploadLimits } from './upload.js';
import {
  configureUploadStagingStore,
  configureUploadStagingStoreFromConfig,
  getUploadStagingStore,
  resetUploadStagingStoreForTests,
} from './upload-staging.js';

afterEach(resetUploadStagingStoreForTests);

describe('upload staging application composition', () => {
  it('injects and reuses one application-level adapter instance', () => {
    const adapter = { stage: async () => ({}) } as UploadStagingStore;
    let constructions = 0;
    configureUploadStagingStore(() => {
      constructions++;
      return adapter;
    });
    expect(getUploadStagingStore()).toBe(adapter);
    expect(getUploadStagingStore()).toBe(adapter);
    expect(constructions).toBe(1);
  });

  it('configures the shared ingress policy from uploads.max_file_size_mb', () => {
    configureUploadStagingStoreFromConfig({
      uploads: { location: '/tmp/agor-upload-test', max_file_size_mb: 7 },
    } as AgorConfig);
    expect(getUploadLimits()).toMatchObject({
      maxFileBytes: 7 * 1024 * 1024,
      maxTotalBytes: 14 * 1024 * 1024,
    });
  });

  it('constructs the built-in S3 adapter for an s3:// location', () => {
    configureUploadStagingStoreFromConfig({
      uploads: { location: 's3://agor-uploads/customer-data' },
    } as AgorConfig);
    expect(getUploadStagingStore()).toBeInstanceOf(S3UploadStagingStore);
  });
});
