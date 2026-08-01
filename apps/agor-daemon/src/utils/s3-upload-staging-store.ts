import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  UploadMetadata,
  UploadOwner,
  UploadReadInput,
  UploadRef,
  UploadStageInput,
  UploadStagingStore,
} from '@agor/core/types';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_TTL_MS } from './upload-staging-store.js';

const HANDLE_PATTERN = /^upl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type S3Metadata = Record<string, string | undefined>;

function forbidden(message = 'Upload not found'): Error {
  return Object.assign(new Error(message), { status: 404 });
}

function safeName(value: string): string {
  return (
    value
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.\./g, '_')
      .replace(/[^A-Za-z0-9._ -]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 200) || 'upload'
  );
}

function encodeTenant(tenantId: string): string {
  const value = tenantId.trim();
  if (!value) throw new Error('A tenant id is required for S3 upload storage');
  return encodeURIComponent(value);
}

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const name = (error as { name?: string }).name;
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

export interface S3UploadLocation {
  bucket: string;
  prefix: string;
}

export function parseS3UploadLocation(location: URL): S3UploadLocation {
  if (location.protocol !== 's3:' || !location.hostname) {
    throw new Error('uploads.location must use s3://<bucket>[/prefix]');
  }
  if (location.username || location.password || location.port || location.search || location.hash) {
    throw new Error('S3 upload locations must not contain credentials, ports, query, or fragment');
  }
  return {
    bucket: location.hostname,
    prefix: location.pathname.replace(/^\/+|\/+$/g, ''),
  };
}

export interface S3UploadStagingStoreOptions {
  maxBytes?: number;
  ttlMs?: number;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
}

/** S3-backed boundary-B upload store. Object keys are never exposed to callers. */
export class S3UploadStagingStore implements UploadStagingStore {
  private readonly client: S3Client;
  private readonly maxBytes: number;
  private readonly ttlMs: number;

  constructor(
    private readonly location: S3UploadLocation,
    options: S3UploadStagingStoreOptions = {}
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error('Invalid upload maxBytes');
    }
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 0) {
      throw new Error('Invalid upload ttlMs');
    }
    this.client = options.client ?? new S3Client(options.clientConfig ?? {});
  }

  private tenantPrefix(tenantId: string): string {
    const base = this.location.prefix ? `${this.location.prefix}/` : '';
    return `${base}tenants/${encodeTenant(tenantId)}/uploads/objects/`;
  }

  private key(tenantId: string, ref: UploadRef): string {
    if (!HANDLE_PATTERN.test(ref)) throw forbidden();
    return `${this.tenantPrefix(tenantId)}${ref.slice(4, 6)}/${ref}`;
  }

  private logical(metadata: S3Metadata, size: number, ref: UploadRef): UploadMetadata {
    if (
      !metadata.name ||
      !metadata['mime-type'] ||
      !metadata['created-at'] ||
      !metadata.provenance ||
      !['browser', 'gateway-slack', 'mcp-slack'].includes(metadata.provenance) ||
      !Number.isFinite(Date.parse(metadata['created-at']))
    ) {
      throw forbidden();
    }
    return {
      ref,
      name: metadata.name,
      mimeType: metadata['mime-type'],
      size,
      createdAt: metadata['created-at'],
      expiresAt: metadata['expires-at'] || null,
      provenance: metadata.provenance as UploadMetadata['provenance'],
    };
  }

  private authorize(input: UploadReadInput, metadata: S3Metadata): void {
    if (
      metadata['tenant-id'] !== input.tenantId ||
      metadata['session-id'] !== input.sessionId ||
      metadata['branch-id'] !== input.branchId
    ) {
      throw forbidden();
    }
    const expiresAt = metadata['expires-at'];
    if (expiresAt) {
      const expiry = Date.parse(expiresAt);
      if (!Number.isFinite(expiry)) throw forbidden();
      if (expiry <= Date.now()) {
        throw Object.assign(new Error('Upload has expired'), { status: 410 });
      }
    }
  }

  private async head(input: UploadReadInput) {
    const Key = this.key(input.tenantId, input.ref);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.location.bucket, Key })
      );
      const metadata = result.Metadata ?? {};
      this.authorize(input, metadata);
      return { Key, metadata, size: result.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) throw forbidden();
      throw error;
    }
  }

  async stage(input: UploadStageInput): Promise<UploadMetadata> {
    if (input.sizeHint !== undefined && input.sizeHint > this.maxBytes) {
      throw Object.assign(new Error(`Upload exceeds ${this.maxBytes}-byte limit`), { status: 413 });
    }
    const ttlMs = input.ttlMs ?? this.ttlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error('Invalid upload ttlMs');
    const ref = `upl_${randomUUID()}` as UploadRef;
    const Key = this.key(input.owner.tenantId, ref);
    const now = new Date();
    const expiresAt = ttlMs === 0 ? null : new Date(now.getTime() + ttlMs).toISOString();
    let size = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.byteLength;
        callback(
          size > this.maxBytes
            ? Object.assign(new Error(`Upload exceeds ${this.maxBytes}-byte limit`), {
                status: 413,
              })
            : null,
          size > this.maxBytes ? undefined : chunk
        );
      },
    });
    const bodyPipeline = pipeline(input.body, limiter);
    const metadata: Record<string, string> = {
      'tenant-id': input.owner.tenantId,
      'session-id': input.owner.sessionId,
      'branch-id': input.owner.branchId,
      'created-by': input.owner.createdBy,
      name: safeName(input.name),
      'mime-type': input.mimeType,
      'created-at': now.toISOString(),
      'expires-at': expiresAt ?? '',
      provenance: input.provenance,
    };
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.location.bucket,
        Key,
        Body: limiter,
        ContentType: input.mimeType,
        Metadata: metadata,
      },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    try {
      await Promise.all([upload.done(), bodyPipeline]);
    } catch (error) {
      limiter.destroy();
      (input.body as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      await upload.abort().catch(() => undefined);
      throw error;
    }
    return this.logical(metadata, size, ref);
  }

  async inspect(input: UploadReadInput): Promise<UploadMetadata> {
    const { metadata, size } = await this.head(input);
    return this.logical(metadata, size, input.ref);
  }

  async read(
    input: UploadReadInput & { offset?: number; length?: number }
  ): Promise<NodeJS.ReadableStream> {
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid upload read offset');
    if (input.length !== undefined && (!Number.isSafeInteger(input.length) || input.length <= 0)) {
      throw new Error('Invalid upload read length');
    }
    const Range =
      input.length === undefined
        ? offset > 0
          ? `bytes=${offset}-`
          : undefined
        : `bytes=${offset}-${offset + input.length - 1}`;
    const Key = this.key(input.tenantId, input.ref);
    let result: GetObjectCommandOutput;
    try {
      result = await this.client.send(
        new GetObjectCommand({ Bucket: this.location.bucket, Key, Range })
      );
    } catch (error) {
      if (isNotFound(error)) throw forbidden();
      throw error;
    }
    this.authorize(input, result.Metadata ?? {});
    if (!result.Body) throw forbidden();
    if (result.Body instanceof Readable) return result.Body;
    return Readable.fromWeb(result.Body.transformToWebStream() as never);
  }

  async consume(input: UploadReadInput): Promise<void> {
    await this.delete(input);
  }

  async delete(input: UploadReadInput): Promise<void> {
    let Key: string;
    try {
      ({ Key } = await this.head(input));
    } catch (error) {
      if ((error as { status?: number }).status === 404) return;
      throw error;
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.location.bucket, Key }));
  }

  async cleanupExpired(owner: Pick<UploadOwner, 'tenantId'>, now = new Date()): Promise<number> {
    const Prefix = this.tenantPrefix(owner.tenantId);
    let removed = 0;
    let ContinuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.location.bucket,
          Prefix,
          ContinuationToken,
        })
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        try {
          const head = await this.client.send(
            new HeadObjectCommand({ Bucket: this.location.bucket, Key: object.Key })
          );
          const metadata = head.Metadata ?? {};
          const expiresAt = metadata['expires-at'];
          const expiry = expiresAt ? Date.parse(expiresAt) : undefined;
          const expired =
            expiry !== undefined && Number.isFinite(expiry) && expiry <= now.getTime();
          const corrupt =
            metadata['tenant-id'] !== owner.tenantId ||
            !metadata['session-id'] ||
            (expiry !== undefined && !Number.isFinite(expiry));
          const staleCorrupt =
            corrupt &&
            now.getTime() - (object.LastModified?.getTime() ?? now.getTime()) >=
              (this.ttlMs || DEFAULT_UPLOAD_TTL_MS);
          if (!expired && !staleCorrupt) continue;
          await this.client.send(
            new DeleteObjectCommand({ Bucket: this.location.bucket, Key: object.Key })
          );
          removed++;
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);

    let KeyMarker: string | undefined;
    let UploadIdMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.location.bucket,
          Prefix,
          KeyMarker,
          UploadIdMarker,
        })
      );
      for (const pending of page.Uploads ?? []) {
        if (
          pending.Key &&
          pending.UploadId &&
          now.getTime() - (pending.Initiated?.getTime() ?? now.getTime()) >=
            (this.ttlMs || DEFAULT_UPLOAD_TTL_MS)
        ) {
          await this.client.send(
            new AbortMultipartUploadCommand({
              Bucket: this.location.bucket,
              Key: pending.Key,
              UploadId: pending.UploadId,
            })
          );
          removed++;
        }
      }
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      UploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
    } while (KeyMarker || UploadIdMarker);
    return removed;
  }
}
