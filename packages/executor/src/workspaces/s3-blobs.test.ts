import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { TenantID } from '@agor/core/types';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterEach, expect, it, vi } from 'vitest';
import { S3WorkspaceBlobs } from './s3-blobs';

// Exercise the storage contract without loading the network client's ESM graph.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  GetObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
  PutObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const bytes = Buffer.from('durable source');
const hash = createHash('sha256').update(bytes).digest('hex');
const response = () => ({ Body: { transformToByteArray: async () => gzipSync(bytes) } });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'agor-blobs-'));
  roots.push(root);
  const send = vi.fn().mockResolvedValue({});
  const make = (tenant = 'tenant-a', bucket = 'bucket-a') =>
    new S3WorkspaceBlobs(
      bucket,
      tenant as TenantID,
      { send } as unknown as S3Client,
      undefined,
      root
    );
  return { root, send, make };
}
it('reuses acknowledged bytes across instances without uploading or downloading again', async () => {
  const { send, make } = await fixture();
  await make().put(hash, bytes);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await make().get(hash)).toEqual(bytes);
  await make().put(hash, bytes);
  expect(send).toHaveBeenCalledTimes(1);
});
it('does not trust failed uploads or share durable-cache authority across tenants or buckets', async () => {
  const { send, make } = await fixture();
  send.mockRejectedValueOnce(new Error('upload failed'));
  await expect(make().put(hash, bytes)).rejects.toThrow('upload failed');
  await make().put(hash, bytes);
  expect(send).toHaveBeenCalledTimes(2);
  send.mockResolvedValue(response());
  await make('tenant-b').get(hash);
  await make('tenant-a', 'bucket-b').get(hash);
  expect(send).toHaveBeenCalledTimes(4);
  expect(send.mock.calls[2][0]).toBeInstanceOf(GetObjectCommand);
});
it('verifies pre-existing remote bytes and repairs corrupt local cache from S3', async () => {
  const { root, send, make } = await fixture();
  send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } }).mockResolvedValue(response());
  await make().put(hash, bytes);
  expect(send).toHaveBeenCalledTimes(2);
  const files = await readdir(root, { recursive: true });
  const file = files.find((name) => path.basename(name) === hash)!;
  expect(await readFile(path.join(root, file))).toEqual(bytes);
  await writeFile(path.join(root, file), 'corrupt');
  expect(await make().get(hash)).toEqual(bytes);
  expect(send).toHaveBeenCalledTimes(3);
  await expect(make().put('invalid', bytes)).rejects.toThrow();
});
