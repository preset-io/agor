import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { getManagedStorageSegments } from '@agor/core/config';
import type { TenantID } from '@agor/core/types';
import type { WorkspaceBlobs } from '@agor/core/workspaces/types';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Reuses the daemon's AWS default credential chain; never receives user subscription credentials. */
export class S3WorkspaceBlobs implements WorkspaceBlobs {
  private readonly prefix: string;
  constructor(
    private readonly bucket: string,
    tenantId: TenantID,
    private readonly client = new S3Client({}),
    private readonly maximumBlobBytes = 128 * 1024 * 1024
  ) {
    this.prefix = getManagedStorageSegments('workspace-blobs', {
      tenantId,
      tenantSeparated: true,
    }).join('/');
  }
  private key(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid workspace blob hash');
    return `${this.prefix}/${hash}`;
  }
  async put(hash: string, content: Buffer): Promise<void> {
    if (content.length > this.maximumBlobBytes || digest(content) !== hash)
      throw new Error('Invalid workspace blob size or checksum');
    const body = gzipSync(content);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(hash),
          Body: body,
          ContentType: 'application/octet-stream',
          ContentEncoding: 'gzip',
          IfNoneMatch: '*',
          ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
        })
      );
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412)
        throw error;
      // A pre-existing key must still contain the expected immutable bytes.
      await this.get(hash);
    }
  }
  async get(hash: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(hash), ChecksumMode: 'ENABLED' })
    );
    if (!result.Body || (result.ContentLength ?? 0) > this.maximumBlobBytes + 65536)
      throw new Error('Invalid workspace blob response');
    const content = gunzipSync(await result.Body.transformToByteArray(), {
      maxOutputLength: this.maximumBlobBytes,
    });
    if (digest(content) !== hash) throw new Error('Workspace blob checksum mismatch');
    return content;
  }
}
