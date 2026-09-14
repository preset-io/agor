/**
 * Upload-middleware tests.
 *
 * The multer instance is opaque, so we exercise its config indirectly:
 *   - the exported MIME allowlist excludes dangerous types
 *   - the limits constants match what the prompt specifies
 *   - the live multer instance carries those limits
 *   - aggregate-size middlewares reject oversize requests (pre + post multer)
 */

import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { UploadStagingStore } from '@agor/core/types';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  createUploadMiddleware,
  createUploadStorage,
  enforceTotalUploadSize,
  getUploadDirectory,
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILES_PER_REQUEST,
  MAX_UPLOAD_TOTAL_SIZE,
  validateUploadDestinationQuery,
} from './upload';

const fakeStore = {
  stage: vi.fn(),
  delete: vi.fn(async () => undefined),
} as unknown as UploadStagingStore;

function mockRes() {
  const res: Partial<Response> & { _status?: number; _body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res as Response;
  });
  res.json = vi.fn((body: unknown) => {
    res._body = body;
    return res as Response;
  });
  return res as Response & { _status?: number; _body?: unknown };
}

describe('upload allowlist', () => {
  it('accepts common safe MIMEs', () => {
    expect(ALLOWED_UPLOAD_MIME_TYPES.has('image/png')).toBe(true);
    expect(ALLOWED_UPLOAD_MIME_TYPES.has('image/jpeg')).toBe(true);
    expect(ALLOWED_UPLOAD_MIME_TYPES.has('text/plain')).toBe(true);
    expect(ALLOWED_UPLOAD_MIME_TYPES.has('text/markdown')).toBe(true);
    expect(ALLOWED_UPLOAD_MIME_TYPES.has('application/pdf')).toBe(true);
  });

  it('rejects HTML / executable / script-bearing MIMEs', () => {
    expect(ALLOWED_UPLOAD_MIME_TYPES.has('text/html')).toBe(false);
    expect(ALLOWED_UPLOAD_MIME_TYPES.has('application/x-msdownload')).toBe(false);
    expect(ALLOWED_UPLOAD_MIME_TYPES.has('application/x-sh')).toBe(false);
    expect(ALLOWED_UPLOAD_MIME_TYPES.has('application/javascript')).toBe(false);
    // SVG is intentionally excluded — can carry inline <script>.
    expect(ALLOWED_UPLOAD_MIME_TYPES.has('image/svg+xml')).toBe(false);
  });

  it('multer instance carries the configured limits', () => {
    // Tiny stand-ins for the repos — the limit fields are read off the multer
    // instance directly, so the storage callbacks never run.
    const mw = createUploadMiddleware(fakeStore);
    // multer attaches the original options under `.limits`
    const limits = (mw as unknown as { limits?: Record<string, number> }).limits;
    expect(limits?.fileSize).toBe(MAX_UPLOAD_FILE_SIZE);
    expect(limits?.files).toBe(MAX_UPLOAD_FILES_PER_REQUEST);
    expect(MAX_UPLOAD_TOTAL_SIZE).toBeGreaterThan(MAX_UPLOAD_FILE_SIZE);
    // CRITICAL: `fieldSize` was previously (mis-)used as the aggregate cap.
    // It must NOT be present here — that field governs non-file form-field
    // VALUES (a single text input), not combined file payload. If it ever
    // reappears here it likely means someone re-introduced the bad ceiling.
    expect(limits?.fieldSize).toBeUndefined();
  });
});

describe('upload destination handling', () => {
  it('stores daemon-side uploads under ~/.agor/uploads', () => {
    expect(getUploadDirectory()).toBe(path.join(os.homedir(), '.agor', 'uploads'));
  });

  it('ignores only legacy no-op destination values', () => {
    expect(() => validateUploadDestinationQuery(undefined)).not.toThrow();
    expect(() => validateUploadDestinationQuery('')).not.toThrow();
    expect(() => validateUploadDestinationQuery('branch')).not.toThrow();
    expect(() => validateUploadDestinationQuery('global')).not.toThrow();
  });

  it('rejects unsupported upload destinations', () => {
    expect(() => validateUploadDestinationQuery('temp')).toThrow(/no longer supported/i);
    expect(() => validateUploadDestinationQuery('workspace')).toThrow(/no longer supported/i);
  });
});

describe('enforceTotalUploadSize (pre-multer Content-Length)', () => {
  it('rejects 413 when Content-Length exceeds MAX_UPLOAD_TOTAL_SIZE', () => {
    const mw = enforceTotalUploadSize();
    const req = {
      headers: { 'content-length': String(MAX_UPLOAD_TOTAL_SIZE + 1) },
      _uploadRequestId: 'request-oversize',
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    mw(req, res, next);
    expect(res._status).toBe(413);
    expect(res._body).toMatchObject({
      error: 'Upload too large',
      code: 'PAYLOAD_TOO_LARGE',
      requestId: 'request-oversize',
    });
    expect(res.locals).toMatchObject({
      uploadFailureCode: 'PAYLOAD_TOO_LARGE',
      uploadFailureType: 'upload_policy',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through when Content-Length is within ceiling', () => {
    const mw = enforceTotalUploadSize();
    const req = {
      headers: { 'content-length': String(MAX_UPLOAD_TOTAL_SIZE - 1) },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    mw(req, res, next);
    expect(res._status).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('passes through when Content-Length header is missing or non-numeric', () => {
    // Defence-in-depth: if Content-Length is absent or junk, the parsed-size
    // middleware (which runs after multer) is the one that catches the abuse.
    const mw = enforceTotalUploadSize();
    const req = { headers: {} } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('streaming upload storage', () => {
  it('passes file.stream directly to the staging port without a Buffer/path result', async () => {
    const stage = vi.fn(async (input: { body: NodeJS.ReadableStream }) => {
      let body = '';
      for await (const chunk of input.body) body += chunk;
      expect(body).toBe('streamed');
      return {
        ref: 'upl_00000000-0000-4000-8000-000000000001',
        name: 'a.txt',
        mimeType: 'text/plain',
        size: 8,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        provenance: 'browser',
      };
    });
    const storage = createUploadStorage({ ...fakeStore, stage } as UploadStagingStore);
    const req = {
      feathers: { tenant: { tenant_id: 'tenant-a' } },
      params: { sessionId: '00000000-0000-0000-0000-000000000001' },
      _uploadOwner: {
        tenantId: 'tenant-a',
        sessionId: '00000000-0000-0000-0000-000000000001',
        branchId: '00000000-0000-0000-0000-000000000002',
        createdBy: '00000000-0000-0000-0000-000000000003',
      },
    };
    const info = await new Promise<Record<string, unknown>>((resolve, reject) =>
      storage._handleFile(
        req as never,
        {
          originalname: 'a.txt',
          mimetype: 'text/plain',
          stream: Readable.from('streamed'),
        } as never,
        (error, result) => (error ? reject(error) : resolve(result as Record<string, unknown>))
      )
    );
    expect(info.ref).toMatch(/^upl_/);
    expect(info).not.toHaveProperty('buffer');
    expect(info).not.toHaveProperty('path');
  });

  it('rejects actual aggregate streamed bytes before staging succeeds', async () => {
    const store = {
      ...fakeStore,
      stage: async (input: { body: NodeJS.ReadableStream }) => {
        for await (const _chunk of input.body) {
          // consume
        }
        throw new Error('unreachable');
      },
    } as UploadStagingStore;
    const storage = createUploadStorage(store);
    const req = {
      feathers: { tenant: { tenant_id: 'tenant-a' } },
      params: { sessionId: '00000000-0000-0000-0000-000000000001' },
      _stagedUploadBytes: MAX_UPLOAD_TOTAL_SIZE,
      _uploadOwner: {
        tenantId: 'tenant-a',
        sessionId: '00000000-0000-0000-0000-000000000001',
        branchId: '00000000-0000-0000-0000-000000000002',
        createdBy: '00000000-0000-0000-0000-000000000003',
      },
    };
    await expect(
      new Promise((resolve, reject) =>
        storage._handleFile(
          req as never,
          {
            originalname: 'a.txt',
            mimetype: 'text/plain',
            stream: Readable.from('x'),
          } as never,
          (error, result) => (error ? reject(error) : resolve(result))
        )
      )
    ).rejects.toThrow(/combined upload size/i);
  });
});
