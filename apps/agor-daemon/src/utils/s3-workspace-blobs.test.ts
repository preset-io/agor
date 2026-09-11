import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { TenantID } from '@agor/core/types';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3WorkspaceBlobs } from './s3-workspace-blobs';

describe('immutable workspace S3 blobs', () => {
  it('uses tenant-scoped keys and conditional writes, verifies duplicate and downloaded bytes', async () => {
    const bytes = Buffer.from('source');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const calls: Array<PutObjectCommand | GetObjectCommand> = [];
    const client = {
      async send(command: PutObjectCommand | GetObjectCommand) {
        calls.push(command);
        if (command instanceof PutObjectCommand) throw { $metadata: { httpStatusCode: 412 } };
        return {
          ContentLength: gzipSync(bytes).length,
          Body: { transformToByteArray: async () => gzipSync(bytes) },
        };
      },
    } as unknown as S3Client;
    const store = new S3WorkspaceBlobs('private-bucket', 'tenant-a' as TenantID, client);
    await store.put(hash, bytes);
    expect(calls[0].input).toMatchObject({
      Bucket: 'private-bucket',
      Key: `tenants/tenant-a/workspace-blobs/${hash}`,
      IfNoneMatch: '*',
    });
    expect(calls[1]).toBeInstanceOf(GetObjectCommand);
    const other = new S3WorkspaceBlobs('private-bucket', 'tenant-b' as TenantID, client);
    await other.get(hash);
    expect(calls[2].input.Key).toBe(`tenants/tenant-b/workspace-blobs/${hash}`);
    await expect(store.put(hash, Buffer.from('wrong'))).rejects.toThrow('checksum');
    await expect(store.get('../escape')).rejects.toThrow('Invalid');
  });
  it('rejects corrupted downloads and interrupted uploads', async () => {
    const client = {
      async send(command: PutObjectCommand | GetObjectCommand) {
        if (command instanceof PutObjectCommand) throw new Error('interrupted');
        return { Body: { transformToByteArray: async () => gzipSync('corrupt') } };
      },
    } as unknown as S3Client;
    const store = new S3WorkspaceBlobs('private', 'tenant' as TenantID, client);
    const bytes = Buffer.from('source');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await expect(store.put(hash, bytes)).rejects.toThrow('interrupted');
    await expect(store.get(hash)).rejects.toThrow('checksum');
  });
});
