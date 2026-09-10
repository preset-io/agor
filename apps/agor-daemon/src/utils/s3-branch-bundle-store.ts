import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BranchBundleReceipt, BranchID } from '@agor/core/types';
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { S3UploadLocation } from './s3-upload-staging-store.js';

/**
 * Durable sibling of upload staging: no TTL, consume-on-read, upload metadata
 * row, or expiry cleanup. Operators must exclude branch-bundles from bucket
 * expiration rules. Uses the existing upload location and AWS credential chain.
 */
export class S3BranchBundleStore {
  constructor(
    private readonly location: S3UploadLocation,
    private readonly client: S3Client
  ) {}

  private key(tenantId: string, branchId: BranchID, operationId: string): string {
    for (const value of [tenantId, branchId, operationId]) {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid bundle owner');
    }
    return `${this.location.prefix ? `${this.location.prefix}/` : ''}branch-bundles/${tenantId}/${branchId}/${operationId}.tgz`;
  }

  async upload(
    owner: { tenantId: string; branchId: BranchID; operationId: string },
    body: Readable
  ): Promise<BranchBundleReceipt> {
    const key = this.key(owner.tenantId, owner.branchId, owner.operationId);
    const hash = createHash('sha256');
    let bytes = 0;
    const measured = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    const transfer = new Upload({
      client: this.client,
      params: {
        Bucket: this.location.bucket,
        Key: key,
        Body: measured,
        ContentType: 'application/gzip',
        ChecksumAlgorithm: 'SHA256',
        Metadata: {
          'tenant-id': owner.tenantId,
          'branch-id': owner.branchId,
          'operation-id': owner.operationId,
        },
      },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    try {
      // SDK computes/sends the provider checksum for each part. The separate
      // SHA-256 here covers the whole compressed stream, never the multipart ETag.
      const [result] = await Promise.all([transfer.done(), pipeline(body, measured)]);
      const head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.location.bucket,
          Key: key,
          VersionId: result.VersionId,
          ChecksumMode: 'ENABLED',
        })
      );
      if (
        !result.ETag ||
        head.ETag !== result.ETag ||
        head.ContentLength !== bytes ||
        !result.ChecksumSHA256 ||
        head.ChecksumSHA256 !== result.ChecksumSHA256 ||
        head.Metadata?.['tenant-id'] !== owner.tenantId ||
        head.Metadata?.['branch-id'] !== owner.branchId ||
        head.Metadata?.['operation-id'] !== owner.operationId
      ) {
        throw new Error('Bundle upload identity, size or provider checksum verification failed');
      }
      return {
        bucket: this.location.bucket,
        key,
        etag: result.ETag,
        versionId: result.VersionId,
        providerChecksum: result.ChecksumSHA256,
        sha256: hash.digest('hex'),
        bytes,
      };
    } catch (error) {
      body.destroy();
      measured.destroy();
      await transfer.abort().catch(() => undefined);
      throw error;
    }
  }

  async read(
    owner: { tenantId: string; branchId: BranchID },
    receipt: BranchBundleReceipt
  ): Promise<Readable> {
    // Receipt keys are DB-owned; still bind them to the caller's tenant/branch
    // before ANY object-store request, including replay with a foreign receipt.
    const prefix = this.key(owner.tenantId, owner.branchId, 'receipt').replace(/receipt\.tgz$/, '');
    if (
      receipt.bucket !== this.location.bucket ||
      !receipt.key.startsWith(prefix) ||
      !/^[A-Za-z0-9_-]+\.tgz$/.test(receipt.key.slice(prefix.length))
    ) {
      throw new Error('Bundle not found');
    }
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: receipt.bucket,
        Key: receipt.key,
        VersionId: receipt.versionId,
        IfMatch: receipt.etag,
        ChecksumMode: 'ENABLED',
      })
    );
    const body =
      result.Body instanceof Readable
        ? result.Body
        : result.Body
          ? Readable.fromWeb(result.Body.transformToWebStream() as never)
          : undefined;
    if (
      !body ||
      result.ContentLength !== receipt.bytes ||
      result.ETag !== receipt.etag ||
      result.ChecksumSHA256 !== receipt.providerChecksum ||
      result.Metadata?.['tenant-id'] !== owner.tenantId ||
      result.Metadata?.['branch-id'] !== owner.branchId
    ) {
      body?.destroy();
      throw new Error('Bundle identity or size changed');
    }
    return body;
  }
}
