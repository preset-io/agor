import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

const compress = promisify(gzip),
  decompress = promisify(gunzip);

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
    private readonly maximumBlobBytes = 128 * 1024 * 1024,
    private readonly cacheRoot?: string,
    private readonly signal?: AbortSignal
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
  private cachedPath(hash: string): string | undefined {
    const key = this.key(hash);
    return this.cacheRoot
      ? path.join(this.cacheRoot, digest(Buffer.from(this.bucket)), key)
      : undefined;
  }
  private async cached(hash: string): Promise<Buffer | undefined> {
    const file = this.cachedPath(hash);
    if (!file) return;
    try {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > this.maximumBlobBytes) return;
        const bytes = await handle.readFile();
        if (digest(bytes) === hash) return bytes;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    // A corrupt cache is never authoritative. Read and verify S3 again.
  }
  private async remember(hash: string, content: Buffer): Promise<void> {
    const file = this.cachedPath(hash);
    if (!file) return;
    const temporary = `${file}.${randomUUID()}`;
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch {
      // Disk cache failures must not turn an acknowledged durable write into a failure.
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  async put(hash: string, content: Buffer): Promise<void> {
    if (content.length > this.maximumBlobBytes || digest(content) !== hash)
      throw new Error('Invalid workspace blob size or checksum');
    // Cache entries are published only after S3 acknowledgment or verified GET.
    // Thus existing bytes avoid duplicate PUT + 412 + GET round trips per branch.
    if (await this.cached(hash)) return;
    const body = await compress(content);
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
        }),
        { abortSignal: this.signal }
      );
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412)
        throw error;
      // A pre-existing key must still contain the expected immutable bytes.
      await this.get(hash);
    }
    await this.remember(hash, content);
  }
  async get(hash: string): Promise<Buffer> {
    const cached = await this.cached(hash);
    if (cached) return cached;
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(hash), ChecksumMode: 'ENABLED' }),
      { abortSignal: this.signal }
    );
    if (!result.Body || (result.ContentLength ?? 0) > this.maximumBlobBytes + 65536)
      throw new Error('Invalid workspace blob response');
    const content = await decompress(await result.Body.transformToByteArray(), {
      maxOutputLength: this.maximumBlobBytes,
    });
    if (digest(content) !== hash) throw new Error('Workspace blob checksum mismatch');
    await this.remember(hash, content);
    return content;
  }
}
