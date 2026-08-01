import { Readable } from 'node:stream';
import type { BranchID, SessionID, TenantID, UploadOwner, UserID } from '@agor/core/types';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetadataUploadStagingStore } from './metadata-upload-staging-store.js';
import { parseS3UploadLocation, S3UploadStagingStore } from './s3-upload-staging-store.js';

const awsMocks = vi.hoisted(() => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return {
    AbortMultipartUploadCommand: class extends Command {},
    DeleteObjectCommand: class extends Command {},
    GetObjectCommand: class extends Command {},
    HeadObjectCommand: class extends Command {},
    ListMultipartUploadsCommand: class extends Command {},
    ListObjectsV2Command: class extends Command {},
    S3Client: class {},
  };
});
const uploadState = vi.hoisted(() => ({ aborts: 0 }));
const repositoryState = vi.hoisted(() => ({ rows: [] as any[] }));

vi.mock('@aws-sdk/client-s3', () => awsMocks);
vi.mock('@agor/core/db', () => ({
  runWithTenantDatabaseScope: async (_db: unknown, _tenant: string, work: () => unknown) => work(),
  UploadRepository: class {
    async create(nextOwner: UploadOwner, metadata: any) {
      const row = { ...nextOwner, ...metadata, status: 'active' };
      repositoryState.rows.push(row);
      return row;
    }
    async findOwned(_tenantId: string, ref: string) {
      return repositoryState.rows.find((row) => row.ref === ref) ?? null;
    }
    async findExpired(_tenantId: string, now: Date) {
      return repositoryState.rows.filter(
        (row) => row.expiresAt && Date.parse(row.expiresAt) < now.getTime()
      );
    }
    async remove(_tenantId: string, ref: string) {
      repositoryState.rows = repositoryState.rows.filter((row) => row.ref !== ref);
    }
  },
}));
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(private readonly options: { client: FakeS3; params: Record<string, unknown> }) {}
    done() {
      return this.options.client.upload(this.options.params);
    }
    async abort() {
      uploadState.aborts++;
    }
  },
}));

interface StoredObject {
  body: Buffer;
  metadata: Record<string, string>;
  lastModified: Date;
}

class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  ranges: Array<string | undefined> = [];
  commands: unknown[] = [];
  lastBody?: Readable;
  objectPages?: any[];
  multipartPages?: any[];

  private id(input: { Bucket?: string; Key?: string }) {
    return `${input.Bucket}/${input.Key}`;
  }

  async upload(params: Record<string, unknown>) {
    const chunks: Buffer[] = [];
    for await (const chunk of params.Body as NodeJS.ReadableStream) chunks.push(Buffer.from(chunk));
    this.objects.set(this.id(params), {
      body: Buffer.concat(chunks),
      metadata: params.Metadata as Record<string, string>,
      lastModified: new Date(),
    });
    return {};
  }

  async send(command: unknown): Promise<any> {
    this.commands.push(command);
    const input = (command as { input: any }).input;
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(this.id(input));
      if (!object) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return { Metadata: object.metadata, ContentLength: object.body.length };
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(this.id(input));
      if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      this.ranges.push(input.Range);
      const match = /^bytes=(\d+)-(\d*)$/.exec(input.Range ?? '');
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) + 1 : undefined;
      this.lastBody = Readable.from(object.body.subarray(start, end));
      return {
        Body: this.lastBody,
        Metadata: object.metadata,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(this.id(input));
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      if (this.objectPages) return this.objectPages.shift() ?? { Contents: [], IsTruncated: false };
      return {
        Contents: [...this.objects.entries()]
          .filter(([id]) => id.startsWith(`${input.Bucket}/${input.Prefix}`))
          .map(([id, object]) => ({
            Key: id.slice(String(input.Bucket).length + 1),
            LastModified: object.lastModified,
          })),
        IsTruncated: false,
      };
    }
    if (command instanceof ListMultipartUploadsCommand) {
      if (this.multipartPages) {
        return this.multipartPages.shift() ?? { Uploads: [], IsTruncated: false };
      }
      return { Uploads: [], IsTruncated: false };
    }
    if (command instanceof AbortMultipartUploadCommand) return {};
    throw new Error(
      `Unexpected command ${(command as { constructor: { name: string } }).constructor.name}`
    );
  }
}

const owner = {
  tenantId: 'tenant-a' as TenantID,
  sessionId: '00000000-0000-4000-8000-000000000001' as SessionID,
  branchId: '00000000-0000-4000-8000-000000000002' as BranchID,
  createdBy: '00000000-0000-4000-8000-000000000003' as UserID,
} satisfies UploadOwner;

async function readText(stream: NodeJS.ReadableStream): Promise<string> {
  let value = '';
  for await (const chunk of stream) value += chunk;
  return value;
}

afterEach(() => {
  vi.useRealTimers();
  uploadState.aborts = 0;
  repositoryState.rows = [];
});

describe('S3UploadStagingStore', () => {
  it('parses bucket and prefix without accepting credentials', () => {
    expect(parseS3UploadLocation(new URL('s3://uploads/root/path/'))).toEqual({
      bucket: 'uploads',
      prefix: 'root/path',
    });
    expect(() => parseS3UploadLocation(new URL('s3://user:secret@uploads/root'))).toThrow(
      /must not contain credentials/i
    );
  });

  it('streams bytes under a tenant prefix and supports true ranged reads', async () => {
    const client = new FakeS3();
    const store = new S3UploadStagingStore(
      { bucket: 'uploads', prefix: 'agor' },
      { client: client as unknown as S3Client }
    );
    const metadata = await store.stage({
      owner,
      name: '../report.txt',
      mimeType: 'text/plain',
      provenance: 'browser',
      body: Readable.from('0123456789'),
    });
    expect(metadata.name).toBe('report.txt');
    expect([...client.objects.keys()][0]).toMatch(
      /^uploads\/agor\/tenants\/tenant-a\/uploads\/objects\/[0-9a-f]{2}\/upl_/
    );
    const stream = await store.read({ ...owner, ref: metadata.ref, offset: 3, length: 4 });
    expect(await readText(stream)).toBe('3456');
    expect(client.ranges).toEqual(['bytes=3-6']);
  });

  it('denies cross-tenant and cross-session access without disclosing keys', async () => {
    const client = new FakeS3();
    const store = new S3UploadStagingStore(
      { bucket: 'uploads', prefix: '' },
      { client: client as unknown as S3Client }
    );
    const metadata = await store.stage({
      owner,
      name: 'secret.txt',
      mimeType: 'text/plain',
      provenance: 'gateway-slack',
      body: Readable.from('secret'),
    });
    await expect(
      store.inspect({ ...owner, tenantId: 'tenant-b' as TenantID, ref: metadata.ref })
    ).rejects.toMatchObject({ status: 404 });
    await store.delete({ ...owner, tenantId: 'tenant-b' as TenantID, ref: metadata.ref });
    expect(client.objects.size).toBe(1);
    await expect(
      store.inspect({
        ...owner,
        sessionId: '00000000-0000-4000-8000-000000000009' as SessionID,
        ref: metadata.ref,
      })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      store.read({
        ...owner,
        sessionId: '00000000-0000-4000-8000-000000000009' as SessionID,
        ref: metadata.ref,
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(client.lastBody?.destroyed).toBe(true);
  });

  it('enforces streamed size and aborts failed multipart work', async () => {
    const client = new FakeS3();
    const store = new S3UploadStagingStore(
      { bucket: 'uploads', prefix: '' },
      { client: client as unknown as S3Client, maxBytes: 4 }
    );
    await expect(
      store.stage({
        owner,
        name: 'large.txt',
        mimeType: 'text/plain',
        provenance: 'browser',
        body: Readable.from('12345'),
      })
    ).rejects.toMatchObject({ status: 413 });
    expect(uploadState.aborts).toBe(1);
    expect(client.objects.size).toBe(0);
  });

  it('expires, cleans up, and deletes idempotently within one tenant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const client = new FakeS3();
    const store = new S3UploadStagingStore(
      { bucket: 'uploads', prefix: '' },
      { client: client as unknown as S3Client, ttlMs: 1_000 }
    );
    const metadata = await store.stage({
      owner,
      name: 'short.txt',
      mimeType: 'text/plain',
      provenance: 'browser',
      body: Readable.from('short'),
    });
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    await expect(store.inspect({ ...owner, ref: metadata.ref })).rejects.toMatchObject({
      status: 410,
    });
    expect(await store.cleanupExpired(owner, new Date())).toBe(1);
    expect(client.objects.size).toBe(0);
    await expect(store.delete({ ...owner, ref: metadata.ref })).resolves.toBeUndefined();
  });

  it('removes expired S3 bytes and database metadata in one decorator cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const client = new FakeS3();
    const bytes = new S3UploadStagingStore(
      { bucket: 'uploads', prefix: '' },
      { client: client as unknown as S3Client, ttlMs: 1_000 }
    );
    const store = new MetadataUploadStagingStore({} as never, bytes);
    await store.stage({
      owner,
      name: 'short.txt',
      mimeType: 'text/plain',
      provenance: 'browser',
      body: Readable.from('short'),
    });
    expect(repositoryState.rows).toHaveLength(1);
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    expect(await store.cleanupExpired(owner, new Date())).toBe(1);
    expect(repositoryState.rows).toHaveLength(0);
    expect(client.objects.size).toBe(0);
  });

  it('paginates object and multipart cleanup within the tenant prefix', async () => {
    const client = new FakeS3();
    const stale = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-02-01T00:00:00Z');
    const prefix = 'root/tenants/tenant-a/uploads/objects/';
    const corruptKey = `${prefix}aa/upl_00000000-0000-4000-8000-000000000001`;
    client.objects.set(`uploads/${corruptKey}`, {
      body: Buffer.from('bad'),
      metadata: { 'tenant-id': 'tenant-a' },
      lastModified: stale,
    });
    client.objectPages = [
      { Contents: [], IsTruncated: true, NextContinuationToken: 'next' },
      { Contents: [{ Key: corruptKey, LastModified: stale }], IsTruncated: false },
    ];
    client.multipartPages = [
      {
        Uploads: [{ Key: `${prefix}aa/first`, UploadId: 'one', Initiated: stale }],
        IsTruncated: true,
        NextKeyMarker: 'key-next',
        NextUploadIdMarker: 'upload-next',
      },
      {
        Uploads: [{ Key: `${prefix}bb/second`, UploadId: 'two', Initiated: stale }],
        IsTruncated: false,
      },
    ];
    const store = new S3UploadStagingStore(
      { bucket: 'uploads', prefix: 'root' },
      { client: client as unknown as S3Client, ttlMs: 1_000 }
    );
    expect(await store.cleanupExpired(owner, now)).toBe(3);
    const aborts = client.commands.filter(
      (command) => command instanceof AbortMultipartUploadCommand
    ) as Array<{ input: { Key: string } }>;
    expect(aborts.map((command) => command.input.Key)).toEqual([
      `${prefix}aa/first`,
      `${prefix}bb/second`,
    ]);
    expect(aborts.every((command) => command.input.Key.startsWith(prefix))).toBe(true);
    const multipartLists = client.commands.filter(
      (command) => command instanceof ListMultipartUploadsCommand
    ) as Array<{ input: { KeyMarker?: string; UploadIdMarker?: string } }>;
    expect(multipartLists[1]?.input).toMatchObject({
      KeyMarker: 'key-next',
      UploadIdMarker: 'upload-next',
    });
  });
});
