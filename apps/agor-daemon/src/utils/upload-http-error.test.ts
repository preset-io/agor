import { describe, expect, it } from 'vitest';
import { toUploadErrorResponse } from './upload-http-error.js';

describe('toUploadErrorResponse', () => {
  it('returns specific copy for reviewed upload policy errors', () => {
    expect(
      toUploadErrorResponse(
        Object.assign(new Error('Unsupported file type: text/html'), {
          status: 415,
          code: 'UNSUPPORTED_MEDIA_TYPE',
        }),
        'request-1'
      )
    ).toEqual({
      status: 415,
      body: {
        error: 'Unsupported file type',
        code: 'UNSUPPORTED_MEDIA_TYPE',
        requestId: 'request-1',
      },
      type: 'upload_policy',
    });
  });

  it.each([
    ['LIMIT_FILE_SIZE', 413, 'A file exceeds the upload size limit', 'multipart'],
    [
      'LIMIT_TOTAL_FILE_SIZE',
      413,
      'Combined upload size exceeds the upload size limit',
      'upload_policy',
    ],
    ['LIMIT_FILE_COUNT', 400, 'Too many files', 'multipart'],
    ['LIMIT_UNEXPECTED_FILE', 400, 'Unexpected upload field', 'multipart'],
    ['PAYLOAD_TOO_LARGE', 413, 'Upload too large', 'upload_policy'],
  ] as const)('maps %s to a stable public response', (code, status, error, type) => {
    expect(toUploadErrorResponse({ code }, 'request-2')).toEqual({
      status,
      body: { error, code, requestId: 'request-2' },
      type,
    });
  });

  it('does not expose arbitrary client-error messages', () => {
    expect(
      toUploadErrorResponse(
        Object.assign(new Error('sensitive authorization detail'), { status: 403 }),
        'request-3'
      )
    ).toEqual({
      status: 403,
      body: {
        error: 'Upload request rejected',
        code: 'UPLOAD_REJECTED',
        requestId: 'request-3',
      },
      type: 'request',
    });
  });

  it('does not expose internal errors or caller-supplied 5xx statuses', () => {
    expect(
      toUploadErrorResponse(
        Object.assign(new Error('/private/staging/path failed'), { status: 502 }),
        'request-4'
      )
    ).toEqual({
      status: 500,
      body: {
        error: 'Upload failed',
        code: 'UPLOAD_FAILED',
        requestId: 'request-4',
      },
      type: 'internal',
    });
  });

  it('preserves Feathers numeric 4xx status codes without exposing their messages', () => {
    expect(
      toUploadErrorResponse(
        Object.assign(new Error('sensitive authz detail'), { code: 403 }),
        'request-5'
      )
    ).toEqual({
      status: 403,
      body: {
        error: 'Upload request rejected',
        code: 'UPLOAD_REJECTED',
        requestId: 'request-5',
      },
      type: 'request',
    });
  });

  it('does not treat a policy code with a 5xx status as a public policy failure', () => {
    expect(
      toUploadErrorResponse({ code: 'UNSUPPORTED_MEDIA_TYPE', status: 500 }, 'request-6')
    ).toEqual({
      status: 500,
      body: {
        error: 'Upload failed',
        code: 'UPLOAD_FAILED',
        requestId: 'request-6',
      },
      type: 'internal',
    });
  });

  it('does not treat a policy code with a wrong 4xx status as a public policy failure', () => {
    expect(
      toUploadErrorResponse({ code: 'UNSUPPORTED_MEDIA_TYPE', status: 400 }, 'request-7')
    ).toEqual({
      status: 400,
      body: {
        error: 'Upload request rejected',
        code: 'UPLOAD_REJECTED',
        requestId: 'request-7',
      },
      type: 'request',
    });
  });
});
