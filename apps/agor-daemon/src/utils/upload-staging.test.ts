import type { UploadStagingStore } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureUploadStagingStore,
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
});
