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
    const errorText = await response.text();
    let error: { error?: string } = {};
    try {
      error = JSON.parse(errorText);
    } catch {
      error = { error: errorText || 'Upload failed' };
    }
    throw new Error(error.error || 'Upload failed');
  }

  return response.json();
}
