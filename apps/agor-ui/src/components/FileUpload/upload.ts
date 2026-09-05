import { getUploadPolicyErrorDefinition, UPLOAD_REQUEST_ID_HEADER } from '@agor/core/types';
import { ACCESS_TOKEN_KEY } from '../../utils/tokenRefresh';

export interface UploadedFile {
  ref: string;
  filename: string;
  size: number;
  mimeType: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface UploadFilesToSessionOptions {
  sessionId: string;
  daemonUrl: string;
  files: File[];
  notifyAgent?: boolean;
  message?: string;
  /** Explicit authentication snapshot for caller-owned long-running uploads. */
  accessToken?: string | null;
  signal?: AbortSignal;
}

export interface UploadFilesToSessionResult {
  success: boolean;
  files: UploadedFile[];
  warning?: string;
}

const MAX_UPLOAD_ERROR_LENGTH = 240;
const SAFE_REQUEST_ID = /^[a-zA-Z0-9-]{1,64}$/;

function boundedErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_UPLOAD_ERROR_LENGTH);
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !SAFE_REQUEST_ID.test(value)) return undefined;
  // Keep the bounded reference identical to the daemon log's request_id so
  // support can search for the value copied from the error message.
  return value;
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('Content-Type');
  if (!contentType) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}

async function getUploadErrorMessage(response: Response): Promise<string> {
  const fallback = `Upload failed (HTTP ${response.status})`;
  const responseText = await response.text();
  let body: { code?: unknown; error?: unknown; requestId?: unknown } = {};

  if (isJsonResponse(response)) {
    try {
      const parsed = JSON.parse(responseText);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed;
      }
    } catch {
      // Proxies and ingress controllers may return HTML or plain text. Never
      // surface that untrusted response body in the persistent application UI.
    }
  }

  const policy = getUploadPolicyErrorDefinition(body.code);
  const message =
    response.status >= 400 && response.status < 500 && policy?.status === response.status
      ? (boundedErrorMessage(body.error) ?? fallback)
      : fallback;
  const requestId =
    safeRequestId(response.headers.get(UPLOAD_REQUEST_ID_HEADER)) ?? safeRequestId(body.requestId);

  return requestId ? `${message} (reference: ${requestId})` : message;
}

export async function uploadFilesToSession({
  sessionId,
  daemonUrl,
  files,
  notifyAgent = false,
  message = '',
  accessToken: explicitAccessToken,
  signal,
}: UploadFilesToSessionOptions): Promise<UploadFilesToSessionResult> {
  const formData = new FormData();

  files.forEach((file) => {
    formData.append('files', file);
  });
  formData.append('notifyAgent', String(notifyAgent));
  formData.append('message', message);

  const uploadUrl = `${daemonUrl}/sessions/${sessionId}/upload`;
  const accessToken =
    explicitAccessToken === undefined
      ? localStorage.getItem(ACCESS_TOKEN_KEY)
      : explicitAccessToken;
  const headers: HeadersInit = {};

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    console.warn('[FileUpload] No access token found in localStorage');
  }

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers,
    body: formData,
    signal,
    // Bearer-only endpoint; do not send cookies/credentials.
  });

  if (!response.ok) {
    throw new Error(await getUploadErrorMessage(response));
  }

  return response.json();
}
