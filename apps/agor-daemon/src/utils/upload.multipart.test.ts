import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { getCurrentTenantId, runWithTenantContext } from '@agor/core/db';
import type { UploadOwner } from '@agor/core/types';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalUploadStagingStore } from '../host/local/upload-staging-store.js';
import {
  configureUploadLimits,
  createUploadMiddleware,
  MAX_UPLOAD_FILE_SIZE,
  type StagedMulterFile,
} from './upload.js';
import { toUploadErrorResponse } from './upload-http-error.js';

const owner = {
  tenantId: 'tenant-a',
  sessionId: '00000000-0000-0000-0000-000000000001',
  branchId: '00000000-0000-0000-0000-000000000002',
  createdBy: '00000000-0000-0000-0000-000000000003',
} as UploadOwner;

function filePart(content: string, name = 'a.txt', field = 'files', mime = 'text/plain') {
  return `--boundary\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n`;
}

describe('multipart ingress with tenant-owned staging', () => {
  let root: string;
  let store: LocalUploadStagingStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'agor-multipart-'));
    // Let Multer, not the store, enforce the smaller per-file ingress limit.
    store = new LocalUploadStagingStore((tenant) => path.join(root, tenant), { maxBytes: 100 });
    configureUploadLimits(8);
  });

  afterEach(async () => {
    configureUploadLimits(MAX_UPLOAD_FILE_SIZE);
    await rm(root, { recursive: true, force: true });
  });

  function parse(body: string | PassThrough, uploadOwner: UploadOwner | null = owner) {
    const stream = typeof body === 'string' ? Readable.from([Buffer.from(body)]) : body;
    const req = Object.assign(stream, {
      headers: {
        'content-type': 'multipart/form-data; boundary=boundary',
        'transfer-encoding': 'chunked',
      },
      _uploadOwner: uploadOwner,
    }) as unknown as Request;
    const middleware = createUploadMiddleware(store).array('files', 10);
    const result = new Promise<{
      error: unknown;
      files: StagedMulterFile[];
      tenant: unknown;
      body: unknown;
    }>((resolve) => {
      runWithTenantContext(uploadOwner?.tenantId ?? owner.tenantId, () => {
        middleware(req, {} as Response, (error?: unknown) => {
          resolve({
            error,
            files: req.files as StagedMulterFile[],
            tenant: getCurrentTenantId(),
            body: req.body,
          });
        });
      });
    });
    return result;
  }

  async function expectEmptyStaging() {
    const entries = await readdir(root, { recursive: true });
    expect(entries.filter((name) => /\.(data|json|partial)$/.test(name))).toEqual([]);
  }

  it('accepts an exact-limit file, sanitizes decoded filenames, and isolates its bytes', async () => {
    const { error, files, tenant } = await parse(
      `${filePart('12345678', '..%22%0A.txt')}--boundary--\r\n`
    );
    expect(error).toBeUndefined();
    expect(tenant).toBe(owner.tenantId);
    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file.size).toBe(8);
    expect(file.originalname).toBe('.."\n.txt');
    expect(file.name).not.toMatch(/["\n]/);
    expect(file).not.toHaveProperty('path');
    expect(file).not.toHaveProperty('buffer');
    const input = { ...owner, ref: file.ref };
    const chunks: Buffer[] = [];
    for await (const chunk of await store.read(input)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('12345678');
    const foreign = { ...input, tenantId: 'tenant-b' as UploadOwner['tenantId'] };
    await expect(store.read(foreign)).rejects.toMatchObject({ status: 404 });
    // Deleting a nonexistent key in the foreign tenant is idempotent, but must
    // never delete the original tenant's bytes.
    await store.delete(foreign);
    const wrongSession = { ...input, sessionId: 'foreign-session' as UploadOwner['sessionId'] };
    await expect(store.read(wrongSession)).rejects.toMatchObject({ status: 404 });
    await expect(store.delete(wrongSession)).rejects.toMatchObject({ status: 404 });
    await expect(store.inspect(input)).resolves.toMatchObject({ size: 8 });
  });

  it.each([
    ['YAML', 'agor-claw-experiment.agor-board.yaml', 'application/x-yaml', 'a: 1\n'],
    ['arbitrary binary', 'firmware.bin', 'application/octet-stream', '\u0000\u0001\u00ff\u007f'],
    ['HTML', 'page.html', 'text/html', '<script>'],
    ['SVG', 'chart.svg', 'image/svg+xml', '<svg/>'],
  ])('accepts a %s upload regardless of type', async (_label, name, mime, content) => {
    const { error, files } = await parse(
      `${filePart(content, name, 'files', mime)}--boundary--\r\n`
    );
    expect(error).toBeUndefined();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name, mimeType: mime });
    const chunks: Buffer[] = [];
    for await (const chunk of await store.read({ ...owner, ref: files[0].ref })) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(content));
  });

  it.each([
    ['../../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\win.ini', 'win.ini'],
    ['/abs/path/x.yml', 'x.yml'],
    // Not percent-decoded by the parser; the store still neutralizes `..`.
    ['..%2F..%2Fpasswd', '__2F__2Fpasswd'],
  ])(
    'sanitizes path-traversal filename %j and stores bytes under a server ref',
    async (raw, safe) => {
      const { error, files } = await parse(`${filePart('x', raw)}--boundary--\r\n`);
      expect(error).toBeUndefined();
      expect(files[0].name).toBe(safe);
      expect(files[0].ref).toMatch(/^upl_[0-9a-f-]{36}$/);
      const stored = await readdir(root, { recursive: true });
      expect(stored.every((entry) => !entry.includes(safe))).toBe(true);
      expect(stored.every((entry) => entry.startsWith(owner.tenantId))).toBe(true);
    }
  );

  it.each([
    ['file size', filePart('123456789'), 'LIMIT_FILE_SIZE', 413],
    ['aggregate size', filePart('12345678').repeat(3), 'LIMIT_TOTAL_FILE_SIZE', 413],
    ['file count', filePart('x').repeat(11), 'LIMIT_FILE_COUNT', 400],
    ['unexpected field', filePart('x', 'a.txt', 'foreign'), 'LIMIT_UNEXPECTED_FILE', 400],
  ])('rejects %s and cleans staged files', async (_label, body, code, status) => {
    const { error } = await parse(`${body}--boundary--\r\n`);
    expect(error).toMatchObject({ code });
    expect(toUploadErrorResponse(error, 'request-test')).toMatchObject({
      status,
      body: { code, requestId: 'request-test' },
    });
    await expectEmptyStaging();
  });

  it('preserves each tenant context when concurrent request streams arrive outside it', async () => {
    const first = new PassThrough();
    const second = new PassThrough();
    const otherOwner = { ...owner, tenantId: 'tenant-b' as UploadOwner['tenantId'] };
    const firstResult = parse(first);
    const secondResult = parse(second, otherOwner);
    expect(getCurrentTenantId()).toBeUndefined();
    second.end(`${filePart('b')}--boundary--\r\n`);
    first.end(`${filePart('a')}--boundary--\r\n`);
    for (const [result, expectedOwner] of [
      [await firstResult, owner],
      [await secondResult, otherOwner],
    ] as const) {
      expect(result.error).toBeUndefined();
      expect(result.tenant).toBe(expectedOwner.tenantId);
      expect(result.files[0].tenantId).toBe(expectedOwner.tenantId);
    }
  });

  it('does not infer a staging owner from multipart fields', async () => {
    const stage = vi.spyOn(store, 'stage');
    const { error } = await parse(
      `--boundary\r\nContent-Disposition: form-data; name="tenantId"\r\n\r\ntenant-b\r\n${filePart('x')}--boundary--\r\n`,
      null
    );
    expect(error).toMatchObject({ message: 'Upload staging requires tenant and session context' });
    expect(stage).not.toHaveBeenCalled();
    await expectEmptyStaging();
  });

  it('rejects indexed fields before allocating sparse arrays, but accepts browser scalar fields', async () => {
    const field = (name: string, value: string) =>
      `--boundary\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    // A small index proves the configured guard without risking a CPU-exhaustion
    // payload if a future dependency change accidentally disables it.
    const rejected = await parse(`${field('items[1]', 'x')}--boundary--\r\n`);
    expect(rejected.error).toMatchObject({ code: 'LIMIT_FIELD_ARRAY_INDEX' });
    expect(toUploadErrorResponse(rejected.error, 'request-field')).toEqual({
      status: 400,
      body: {
        error: 'Upload request rejected',
        code: 'UPLOAD_REJECTED',
        requestId: 'request-field',
      },
      type: 'multipart',
    });
    await expectEmptyStaging();
    const accepted = await parse(
      `${filePart('x')}${field('notifyAgent', 'true')}${field('message', 'hello')}--boundary--\r\n`
    );
    expect(accepted.error).toBeUndefined();
    expect(accepted.body).toEqual({ notifyAgent: 'true', message: 'hello' });
  });

  it('settles staging and removes partial bytes when the multipart body is truncated', async () => {
    const stage = vi.spyOn(store, 'stage');
    const { error } = await parse(filePart('partial').slice(0, -2));
    expect(error).toBeInstanceOf(Error);
    expect(stage).toHaveBeenCalledOnce();
    // The parser can report failure before asynchronous staging cleanup finishes.
    await expect(stage.mock.results[0].value).rejects.toThrow();
    await expectEmptyStaging();
  });

  it('settles staging and cleans partial bytes after a client disconnect', async () => {
    const stream = new PassThrough();
    const stage = vi.spyOn(store, 'stage');
    const result = parse(stream);
    stream.write(filePart('partial').slice(0, -2));
    expect(stage).toHaveBeenCalledOnce();
    stream.destroy(new Error('client disconnected'));
    expect((await result).error).toBeInstanceOf(Error);
    await expect(stage.mock.results[0].value).rejects.toThrow();
    await expectEmptyStaging();
  });

  it('removes a file whose staging callback completes after the request has aborted', async () => {
    let release!: () => void;
    let staged!: () => void;
    let deleted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      staged = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      deleted = resolve;
    });
    const originalStage = store.stage.bind(store);
    const originalDelete = store.delete.bind(store);
    vi.spyOn(store, 'stage').mockImplementation(async (input) => {
      const metadata = await originalStage(input);
      staged();
      await gate;
      return metadata;
    });
    const remove = vi.spyOn(store, 'delete').mockImplementation(async (input) => {
      await originalDelete(input);
      deleted();
    });
    const stream = new PassThrough();
    const result = parse(stream);
    stream.write(`${filePart('ready')}--boundary--\r\n`);
    await ready;
    stream.destroy(new Error('client disconnected before staging callback'));
    expect((await result).error).toBeInstanceOf(Error);
    release();
    await cleanup;
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: owner.tenantId,
        sessionId: owner.sessionId,
        branchId: owner.branchId,
      })
    );
    await expectEmptyStaging();
  });
});
