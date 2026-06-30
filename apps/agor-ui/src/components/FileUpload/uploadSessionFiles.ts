import { ACCESS_TOKEN_KEY } from '../../utils/tokenRefresh';

export interface UploadedFile {
  filename: string;
  path: string;
  size: number;
  mimeType: string;
}

export interface UploadSessionFilesParams {
  sessionId: string;
  daemonUrl: string;
  files: File[];
  /** When true, the daemon posts an agent notification referencing the file(s). */
  notifyAgent: boolean;
  /** Notification body; `{filepath}` is substituted server-side. Only used when notifyAgent. */
  message?: string;
}

/**
 * Upload one or more files to a session via `POST /sessions/:id/upload`.
 *
 * Shared by the FileUpload modal and the inline image-paste flow so both speak
 * to the exact same endpoint, auth scheme, and response shape. Returns the
 * stored files (path + final filename) on success and throws a clean Error on
 * failure for the caller to surface.
 */
export async function uploadSessionFiles({
  sessionId,
  daemonUrl,
  files,
  notifyAgent,
  message,
}: UploadSessionFilesParams): Promise<UploadedFile[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  formData.append('notifyAgent', String(notifyAgent));
  if (message !== undefined) {
    formData.append('message', message);
  }

  // Get JWT token from localStorage (same as Feathers client)
  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
  const headers: HeadersInit = {};
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    console.warn('[uploadSessionFiles] No access token found in localStorage');
  }

  const response = await fetch(`${daemonUrl}/sessions/${sessionId}/upload`, {
    method: 'POST',
    headers,
    body: formData,
    // No `credentials: 'include'` — the upload endpoint is Bearer-only
    // (cookie auth was removed to avoid CSRF). Sending credentials would
    // also force a non-wildcard Access-Control-Allow-Origin, which the
    // daemon's CORS layer answers with '*', breaking the preflight.
  });

  if (!response.ok) {
    const errorText = await response.text();
    let error: { error?: string } = {};
    try {
      error = JSON.parse(errorText);
    } catch {
      error = { error: errorText || 'Upload failed' };
    }
    throw new Error(error.error || 'Upload failed');
  }

  const result = await response.json();
  return result.files as UploadedFile[];
}
