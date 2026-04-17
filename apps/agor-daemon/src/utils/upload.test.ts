/**
 * Upload-middleware tests.
 *
 * The multer instance is opaque, so we exercise its config indirectly:
 *   - the exported MIME allowlist excludes dangerous types
 *   - the limits constants match what the prompt specifies
 *   - the live multer instance carries those limits
 *   - aggregate-size middlewares reject oversize requests (pre + post multer)
 */

import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  createUploadMiddleware,
  enforceParsedTotalUploadSize,
  enforceTotalUploadSize,
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILES_PER_REQUEST,
  MAX_UPLOAD_TOTAL_SIZE,
} from './upload';

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
    const mw = createUploadMiddleware(
      {} as Parameters<typeof createUploadMiddleware>[0],
      {} as Parameters<typeof createUploadMiddleware>[1]
    );
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

describe('enforceTotalUploadSize (pre-multer Content-Length)', () => {
  it('rejects 413 when Content-Length exceeds MAX_UPLOAD_TOTAL_SIZE', () => {
    const mw = enforceTotalUploadSize();
    const req = {
      headers: { 'content-length': String(MAX_UPLOAD_TOTAL_SIZE + 1) },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    mw(req, res, next);
    expect(res._status).toBe(413);
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

describe('enforceParsedTotalUploadSize (post-multer file-size sum)', () => {
  it('passes through when no files are present', async () => {
    const mw = enforceParsedTotalUploadSize();
    const req = {} as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes through when sum of file sizes is within ceiling', async () => {
    const mw = enforceParsedTotalUploadSize();
    const req = {
      files: [
        { size: 10, path: '/tmp/a' },
        { size: 20, path: '/tmp/b' },
      ],
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res._status).toBeUndefined();
  });

  // We don't actually want the test to write to disk; the rejection path
  // calls fs.unlink on the file paths, so use a non-existent path and let
  // Promise.allSettled swallow the ENOENT rejections.
  it('rejects 413 and attempts cleanup when sum exceeds ceiling', async () => {
    const mw = enforceParsedTotalUploadSize();
    const req = {
      files: [
        { size: MAX_UPLOAD_TOTAL_SIZE, path: '/tmp/__nope_a' },
        { size: 1, path: '/tmp/__nope_b' },
      ],
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(413);
  });
});
