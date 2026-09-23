import { getUploadPolicyErrorDefinition, UPLOAD_REQUEST_ID_HEADER } from '@agor/core/types';
import { isExpiringSoon } from '../../utils/jwtExpiry';
import {
  readStoredCredentialOwner,
  refreshStoredAccessTokenForOwner,
} from '../../utils/storedTokenRecovery';
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
// Refresh a stored access token this close to expiry before spending an
// upload on it; the daemon rejects expired bearers before reading the body.
const UPLOAD_TOKEN_REFRESH_BUFFER_MS = 30_000;
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
  // An explicit snapshot is never swapped for whatever localStorage holds
  // now. The ambient stored token may be refreshed, but only while it still
  // belongs to whoever initiated the upload (another tab can sign in as
  // someone else mid-request).
  let accessToken =
    explicitAccessToken === undefined
      ? localStorage.getItem(ACCESS_TOKEN_KEY)
      : explicitAccessToken;
  const owner = explicitAccessToken === undefined ? readStoredCredentialOwner(accessToken) : null;

  if (owner && accessToken && isExpiringSoon(accessToken, UPLOAD_TOKEN_REFRESH_BUFFER_MS)) {
    accessToken = (await refreshStoredAccessTokenForOwner(daemonUrl, owner)) ?? accessToken;
  }

  const send = (token: string | null | undefined) => {
    const headers: HeadersInit = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    } else {
      console.warn('[FileUpload] No access token found in localStorage');
    }
    return fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: formData,
      signal,
      // Bearer-only endpoint; do not send cookies/credentials.
    });
  };

  let response = await send(accessToken);

  // The access token can expire while the tab's socket stays connected (the
  // socket authenticated at handshake), so a 401 here usually means only this
  // raw fetch holds a stale bearer. Refresh once and retry with the new token.
  if (response.status === 401 && owner) {
    const refreshed = await refreshStoredAccessTokenForOwner(daemonUrl, owner);
    if (refreshed && refreshed !== accessToken) {
      response = await send(refreshed);
    }
  }

  if (!response.ok) {
    throw new Error(await getUploadErrorMessage(response));
  }

  return response.json();
}
