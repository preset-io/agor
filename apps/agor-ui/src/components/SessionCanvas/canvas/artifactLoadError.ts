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

/** Verbatim from the daemon's `ArtifactsService.getPayload`. */
const ARTIFACT_NOT_FOUND = /^Artifact \S+ not found$/;
const ARTIFACT_HAS_NO_FILES = 'has no files in DB';

const ARTIFACT_UNAVAILABLE =
  "This artifact isn't available. It may have been deleted, or you may not have access.";

export function describeArtifactLoadFailure(failure: ArtifactLoadFailure): ArtifactLoadNotice {
  const details: CompactNoticeDetail[] = [
    ...(failure.status ? [{ label: 'Status', value: String(failure.status), code: true }] : []),
    { label: 'Error', value: failure.message, code: true },
  ];
  // getPayload answers both of these as plain 500s, and retrying can't change either.
  if (failure.status === 404 || ARTIFACT_NOT_FOUND.test(failure.message)) {
    return { message: ARTIFACT_UNAVAILABLE, canRetry: false, details };
  }
  const canRetry = !failure.message.includes(ARTIFACT_HAS_NO_FILES);
  return { message: "Couldn't load this artifact.", canRetry, details };
}
