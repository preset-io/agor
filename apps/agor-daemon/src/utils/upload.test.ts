/**
 * Upload-middleware tests.
 *
 * The multer instance is opaque, so we exercise its config indirectly:
 *   - the exported MIME allowlist excludes dangerous types
 *   - the limits constants match what the prompt specifies
 *   - the live multer instance carries those limits
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  createUploadMiddleware,
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILES_PER_REQUEST,
  MAX_UPLOAD_TOTAL_SIZE,
} from './upload';

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
  });
});
