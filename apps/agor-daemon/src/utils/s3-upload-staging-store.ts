import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getManagedStorageSegments } from '@agor/core/config';
import type {
  UploadMetadata,
  UploadOwner,
  UploadReadInput,
  UploadRef,
  UploadStageInput,
  UploadStagingStore,
} from '@agor/core/types';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_TTL_MS } from './upload-staging-store.js';

const HANDLE_PATTERN = /^upl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type S3Metadata = Record<string, string | undefined>;
const PROVENANCE = new Set(['browser', 'gateway-slack', 'mcp-slack']);

interface ParsedS3Metadata {
  tenantId: string;
  sessionId: string;
  branchId: string;
  name: string;
  mimeType: string;
  createdAt: string;
  expiresAt: string | null;
  provenance: UploadMetadata['provenance'];
}

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

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const name = (error as { name?: string }).name;
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

function parseStoredMetadata(metadata: S3Metadata): ParsedS3Metadata {
  const createdAt = metadata['created-at'];
  const expiresAt = metadata['expires-at'] || null;
  if (
    !metadata['tenant-id'] ||
    !metadata['session-id'] ||
    !metadata['branch-id'] ||
    !metadata.name ||
    !metadata['mime-type'] ||
    !createdAt ||
    !metadata.provenance ||
    !PROVENANCE.has(metadata.provenance) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))
  ) {
    throw forbidden();
  }
  return {
    tenantId: metadata['tenant-id'],
    sessionId: metadata['session-id'],
    branchId: metadata['branch-id'],
    name: metadata.name,
    mimeType: metadata['mime-type'],
    createdAt,
    expiresAt,
    provenance: metadata.provenance as UploadMetadata['provenance'],
  };
}

function disposeBody(body: unknown): void {
  const destroy = (body as { destroy?: () => void })?.destroy;
  if (typeof destroy === 'function') {
    destroy.call(body);
    return;
  }
  const cancel = (body as { cancel?: () => Promise<void> })?.cancel;
  if (typeof cancel === 'function') void cancel.call(body).catch(() => undefined);
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
    const managed = getManagedStorageSegments('uploads', {
      tenantId,
      tenantSeparated: true,
    }).join('/');
    return `${base}${managed}/objects/`;
  }

  private key(tenantId: string, ref: UploadRef): string {
    if (!HANDLE_PATTERN.test(ref)) throw forbidden();
    return `${this.tenantPrefix(tenantId)}${ref.slice(4, 6)}/${ref}`;
  }

  private logical(metadata: S3Metadata, size: number, ref: UploadRef): UploadMetadata {
    const parsed = parseStoredMetadata(metadata);
    return {
      ref,
      name: parsed.name,
      mimeType: parsed.mimeType,
      size,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
      provenance: parsed.provenance,
    };
  }

  private authorize(input: UploadReadInput, metadata: S3Metadata, allowExpired = false): void {
    const parsed = parseStoredMetadata(metadata);
    if (
      parsed.tenantId !== input.tenantId ||
      parsed.sessionId !== input.sessionId ||
      parsed.branchId !== input.branchId
    ) {
      throw forbidden();
    }
    if (!allowExpired && parsed.expiresAt) {
      if (Date.parse(parsed.expiresAt) <= Date.now()) {
        throw Object.assign(new Error('Upload has expired'), { status: 410 });
      }
    }
  }

  private async head(input: UploadReadInput, allowExpired = false) {
    const Key = this.key(input.tenantId, input.ref);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.location.bucket, Key })
      );
      const metadata = result.Metadata ?? {};
      this.authorize(input, metadata, allowExpired);
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
    try {
      this.authorize(input, result.Metadata ?? {});
    } catch (error) {
      disposeBody(result.Body);
      throw error;
    }
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
      ({ Key } = await this.head(input, true));
    } catch (error) {
      if ((error as { status?: number }).status === 404) return;
      throw error;
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.location.bucket, Key }));
  }

  async cleanupExpired(owner: Pick<UploadOwner, 'tenantId'>, now = new Date()): Promise<number> {
    // S3 expiry and abandoned multipart cleanup belong to bucket lifecycle
    // policy. Request handling never lists or reconciles a tenant prefix.
    void owner;
    void now;
    return 0;
  }
}
