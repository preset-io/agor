import {
  getUploadPolicyErrorDefinition,
  UPLOAD_POLICY_ERROR_CONTRACT,
  type UploadPolicyErrorCode,
} from '@agor/core/types';
import multer from 'multer';

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

  // Multer 2.3+ rejects malformed/indexed field names rather than allowing
  // append-field to crash or exhaust the process. Keep parser details private.
  if (
    error instanceof multer.MulterError &&
    ['INVALID_FIELD_NAME', 'LIMIT_FIELD_ARRAY_INDEX'].includes(error.code) &&
    status === undefined
  ) {
    return {
      status: 400,
      body: { error: 'Upload request rejected', code: 'UPLOAD_REJECTED', requestId },
      type: 'multipart',
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

export type UploadAuthFailureReason =
  | 'missing_bearer'
  | 'token_expired'
  | 'token_invalid'
  | 'credentials_invalidated'
  | 'tenant_rejected'
  | 'not_authenticated'
  | 'authentication_error';

export interface UploadAuthFailureDiagnostics {
  reason: UploadAuthFailureReason;
  /** The rejected token's claimed (unverified) `sub`; a diagnostic hint, never authority. */
  claimedSubject?: string;
  /** The rejected token's claimed (unverified) `exp` as an ISO timestamp. */
  claimedExpiresAt?: string;
}

// Any UUID version: users created before UUIDv7 IDs still carry v4 IDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Log only identifier-shaped values from unauthenticated input; anything
 * else is caller-controlled text and is omitted.
 */
export function uuidOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
}

// ECMAScript Date range; larger values would make toISOString throw.
const MAX_JWT_EXP_SECONDS = 8.64e12;

type AuthErrorLike = {
  name?: unknown;
  className?: unknown;
  message?: unknown;
  data?: { name?: unknown } | null;
};

/**
 * Classify a rejected upload bearer into a bounded reason for operational
 * logs. The browser response stays generic; this only exists so a support
 * reference can be tied to why authentication failed.
 */
export function classifyUploadAuthFailure(
  error: unknown,
  unverifiedPayload?: { sub?: unknown; exp?: unknown } | null
): UploadAuthFailureDiagnostics {
  const candidate = (error !== null && typeof error === 'object' ? error : {}) as AuthErrorLike;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  const causeName = typeof candidate.data?.name === 'string' ? candidate.data.name : undefined;

  let reason: UploadAuthFailureReason;
  if (causeName === 'TokenExpiredError' || /jwt expired/i.test(message)) {
    reason = 'token_expired';
  } else if (
    causeName === 'JsonWebTokenError' ||
    causeName === 'NotBeforeError' ||
    /jwt (malformed|audience|issuer)|invalid (signature|token)|JWT type is not valid/i.test(message)
  ) {
    reason = 'token_invalid';
  } else if (/Session expired|credential metadata unavailable/i.test(message)) {
    reason = 'credentials_invalidated';
  } else if (/tenant/i.test(message)) {
    reason = 'tenant_rejected';
  } else if (candidate.className === 'not-authenticated' || candidate.name === 'NotAuthenticated') {
    reason = 'not_authenticated';
  } else {
    reason = 'authentication_error';
  }

  const claimedSubject = uuidOrUndefined(unverifiedPayload?.sub);
  const exp = unverifiedPayload?.exp;
  const claimedExpiresAt =
    typeof exp === 'number' && Number.isFinite(exp) && Math.abs(exp) <= MAX_JWT_EXP_SECONDS
      ? new Date(exp * 1000).toISOString()
      : undefined;

  return { reason, claimedSubject, claimedExpiresAt };
}
