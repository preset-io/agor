import { ACCESS_TOKEN_KEY } from '../../utils/tokenRefresh';

export type UploadDestination = 'branch' | 'global';

export interface UploadedFile {
  filename: string;
  path: string;
  size: number;
  mimeType: string;
  linkId?: string;
}

export interface UploadFilesToSessionOptions {
  sessionId: string;
  daemonUrl: string;
  files: File[];
  destination?: UploadDestination;
  notifyAgent?: boolean;
  message?: string;
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
  destination,
  notifyAgent = false,
  message = '',
}: UploadFilesToSessionOptions): Promise<UploadFilesToSessionResult> {
  const formData = new FormData();

  files.forEach((file) => {
    formData.append('files', file);
  });
  formData.append('notifyAgent', String(notifyAgent));
  formData.append('message', message);

  const uploadUrl = `${daemonUrl}/sessions/${sessionId}/upload${
    destination ? `?destination=${encodeURIComponent(destination)}` : ''
  }`;
  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
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
