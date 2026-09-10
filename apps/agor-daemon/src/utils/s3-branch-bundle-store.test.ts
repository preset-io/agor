import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { BranchID } from '@agor/core/types';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3BranchBundleStore } from './s3-branch-bundle-store.js';

const state = vi.hoisted(() => ({
  bytes: Buffer.alloc(0),
  metadata: {} as Record<string, string>,
  aborted: false,
}));
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(
      private options: {
        params: { Body: Readable; Metadata: Record<string, string>; ChecksumAlgorithm: string };
      }
    ) {
      expect(options.params.ChecksumAlgorithm).toBe('SHA256');
    }
    async done() {
      const chunks: Buffer[] = [];
      for await (const chunk of this.options.params.Body) chunks.push(chunk);
      state.bytes = Buffer.concat(chunks);
      state.metadata = this.options.params.Metadata;
      return {
        ETag: 'opaque-etag-2',
        ChecksumSHA256: createHash('sha256').update(state.bytes).digest('base64'),
        VersionId: 'v1',
      };
    }
    async abort() {
      state.aborted = true;
    }
  },
}));

function fixture(overrides: Record<string, unknown> = {}) {
  const send = vi.fn(async (command: unknown) => ({
    ETag: 'opaque-etag-2',
    ContentLength: state.bytes.length,
    Metadata: state.metadata,
    ChecksumSHA256: createHash('sha256').update(state.bytes).digest('base64'),
    ...(command instanceof GetObjectCommand ? { Body: Readable.from(state.bytes) } : {}),
    ...overrides,
  }));
  const store = new S3BranchBundleStore({ bucket: 'test-only', prefix: 'managed' }, {
    send,
  } as unknown as S3Client);
  return { store, send };
}
const owner = {
  tenantId: 'tenant-a',
  branchId: 'branch-a' as BranchID,
  operationId: 'operation-a',
};

beforeEach(() => {
  state.bytes = Buffer.alloc(0);
  state.metadata = {};
  state.aborted = false;
});
describe('durable bundle adapter (mocked provider, not live object-store validation)', () => {
  it('hashes the upload stream once and retains the object on read without upload-expiry metadata', async () => {
    const { store, send } = fixture();
    const receipt = await store.upload(owner, Readable.from(['whole ', 'workspace']));
    expect(receipt.sha256).toBe(createHash('sha256').update('whole workspace').digest('hex'));
    expect(receipt.key).toBe('managed/branch-bundles/tenant-a/branch-a/operation-a.tgz');
    expect(state.metadata).not.toHaveProperty('expires-at');
    const chunks: Buffer[] = [];
    for await (const chunk of await store.read(owner, receipt)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('whole workspace');
    expect(send).toHaveBeenCalledTimes(2); // HEAD + GET, never verification-download/delete.
  });

  it.each([{ ContentLength: 999 }, { ChecksumSHA256: undefined }, { ETag: 'different' }])(
    'refuses an unverified upload receipt: %j',
    async (overrides) => {
      const { store } = fixture(overrides);
      await expect(store.upload(owner, Readable.from(['bytes']))).rejects.toThrow(
        'verification failed'
      );
      expect(state.aborted).toBe(true);
    }
  );

  it('rejects a foreign-tenant receipt before making any provider request', async () => {
    const { store, send } = fixture();
    const receipt = await store.upload(owner, Readable.from(['private bytes']));
    send.mockClear();
    await expect(store.read({ ...owner, tenantId: 'tenant-b' }, receipt)).rejects.toThrow(
      'not found'
    );
    await expect(
      store.read({ ...owner, branchId: 'branch-b' as BranchID }, receipt)
    ).rejects.toThrow('not found');
    expect(send).not.toHaveBeenCalled();
  });
});
