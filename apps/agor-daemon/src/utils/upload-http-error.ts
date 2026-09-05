import {
  getUploadPolicyErrorDefinition,
  UPLOAD_POLICY_ERROR_CONTRACT,
  type UploadPolicyErrorCode,
} from '@agor/core/types';

export type UploadFailureStage =
  | 'authentication'
  | 'request_size'
  | 'authorization'
  | 'multipart'
  | 'handler';

type UploadFailureType = 'upload_policy' | 'multipart' | 'request' | 'internal';

interface UploadErrorResponse {
  status: number;
  body: {
    error: string;
    code: string;
    requestId: string;
  };
  type: UploadFailureType;
}

type ErrorLike = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

const EXPECTED_UPLOAD_ERRORS: Readonly<
  Record<UploadPolicyErrorCode, { error: string; type: UploadFailureType }>
> = {
  [UPLOAD_POLICY_ERROR_CONTRACT.unsupportedMediaType.code]: {
    error: 'Unsupported file type',
    type: 'upload_policy',
  },
  [UPLOAD_POLICY_ERROR_CONTRACT.fileSize.code]: {
    error: 'A file exceeds the upload size limit',
    type: 'multipart',
  },
  [UPLOAD_POLICY_ERROR_CONTRACT.totalFileSize.code]: {
    error: 'Combined upload size exceeds the upload size limit',
    type: 'upload_policy',
  },
  [UPLOAD_POLICY_ERROR_CONTRACT.fileCount.code]: {
    error: 'Too many files',
    type: 'multipart',
  },
  [UPLOAD_POLICY_ERROR_CONTRACT.unexpectedFile.code]: {
    error: 'Unexpected upload field',
    type: 'multipart',
  },
  [UPLOAD_POLICY_ERROR_CONTRACT.payloadTooLarge.code]: {
    error: 'Upload too large',
    type: 'upload_policy',
  },
};

function asErrorLike(error: unknown): ErrorLike {
  return error !== null && typeof error === 'object' ? (error as ErrorLike) : {};
}

function errorHttpStatus(error: ErrorLike): number | undefined {
  for (const candidate of [error.status, error.statusCode, error.code]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Convert route errors to a small public contract. Only explicitly reviewed
 * upload-policy errors receive specific copy; arbitrary exception messages are
 * never returned to the browser.
 */
export function toUploadErrorResponse(error: unknown, requestId: string): UploadErrorResponse {
  const candidate = asErrorLike(error);
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  const status = errorHttpStatus(candidate);
  const policy = code ? getUploadPolicyErrorDefinition(code) : undefined;
  const expected = policy ? EXPECTED_UPLOAD_ERRORS[policy.code] : undefined;

  if (policy && expected && (status === undefined || status === policy.status)) {
    return {
      status: policy.status,
      body: { error: expected.error, code: policy.code, requestId },
      type: expected.type,
    };
  }

  const suppliedStatus = status ?? 500;
  const isClientError = suppliedStatus >= 400 && suppliedStatus < 500;

  return {
    status: isClientError ? suppliedStatus : 500,
    body: {
      error: isClientError ? 'Upload request rejected' : 'Upload failed',
      code: isClientError ? 'UPLOAD_REJECTED' : 'UPLOAD_FAILED',
      requestId,
    },
    type: isClientError ? 'request' : 'internal',
  };
}
