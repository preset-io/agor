import type { ArtifactPayload } from '@agor-live/client';
import { getDaemonUrl } from '@/config/daemon';
import { getAuthHeaders } from '@/utils/authHeaders';
import type { CompactNoticeDetail } from '../../CompactNotice';

/** A failed artifact payload load; `status` is absent when no response came back. */
export interface ArtifactLoadFailure {
  status?: number;
  message: string;
}

export interface ArtifactLoadNotice {
  message: string;
  canRetry: boolean;
  details: CompactNoticeDetail[];
}

/** Reads the Feathers JSON error body, since `statusText` is blank over HTTP/2. */
export async function readArtifactLoadFailure(res: Response): Promise<ArtifactLoadFailure> {
  let message = '';
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      message = body.message;
    }
  } catch {
    // Not JSON (e.g. a proxy error page): fall back to the status line.
  }
  return { status: res.status, message: message || res.statusText || `HTTP ${res.status}` };
}

export type ArtifactPayloadResult =
  | { payload: ArtifactPayload; failure?: undefined }
  | { payload?: undefined; failure: ArtifactLoadFailure };

/** Shared by the board card and the fullscreen page. */
export async function fetchArtifactPayload(artifactId: string): Promise<ArtifactPayloadResult> {
  try {
    const res = await fetch(`${getDaemonUrl()}/artifacts/${artifactId}/payload`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return { failure: await readArtifactLoadFailure(res) };
    return { payload: (await res.json()) as ArtifactPayload };
  } catch (err) {
    return { failure: { message: err instanceof Error ? err.message : String(err) } };
  }
}

export function describeArtifactLoadFailure(failure: ArtifactLoadFailure): ArtifactLoadNotice {
  const details: CompactNoticeDetail[] = [
    ...(failure.status ? [{ label: 'Status', value: String(failure.status), code: true }] : []),
    { label: 'Error', value: failure.message, code: true },
  ];
  if (failure.status === 403) {
    return { message: "You don't have access to this artifact.", canRetry: false, details };
  }
  if (failure.status === 404) {
    return { message: 'This artifact no longer exists.', canRetry: false, details };
  }
  return { message: "Couldn't load this artifact.", canRetry: true, details };
}
