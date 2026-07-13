/**
 * Server-side ingestion of inbound gateway message attachments.
 *
 * Downloads image and text-like files attached to inbound Slack messages
 * using the channel's bot token and stores them in the daemon upload
 * directory — the same destination the session composer's
 * `/sessions/:sessionId/upload` route writes to — so the session's agent can
 * Read them by absolute path.
 *
 * Other attachment types (PDFs, office documents, archives, media) are out of
 * scope and never downloaded. Downloads are restricted to Slack-owned hosts
 * and to the same per-file size / per-message count ceilings the upload route
 * enforces.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { InboundFile } from '@agor/core/gateway';
import {
  buildUploadFilename,
  getUploadDirectory,
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILES_PER_REQUEST,
  MAX_UPLOAD_TOTAL_SIZE,
} from './upload.js';

export interface AttachmentIngestResult {
  /** Absolute paths of stored files, in the order the attachments arrived. */
  paths: string[];
  /** Ingestable attachments that could not be fetched or stored. */
  failed: number;
}

const MAX_REDIRECT_HOPS = 3;

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function rejectResponse(response: Response, message: string): Promise<never> {
  await cancelResponseBody(response);
  throw new Error(message);
}

/**
 * Whether a platform file URL may be downloaded with the channel's bot token.
 * Slack serves `url_private_download` from files.slack.com; anything outside
 * slack.com would leak the bot token to an attacker-controlled host.
 */
export function isAllowedSlackFileUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'slack.com' || host.endsWith('.slack.com');
}

/**
 * MIME types that are safe to ingest from a remote gateway and preview or pass
 * as text context. Direct browser uploads intentionally remain unrestricted;
 * this allowlist only protects bot-token gateway downloads.
 */
const SAFE_GATEWAY_INGEST_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

function isAllowedIngestMime(rawMime: string): boolean {
  const mime = rawMime.split(';')[0].trim().toLowerCase();
  return SAFE_GATEWAY_INGEST_MIME_TYPES.has(mime);
}

/** Safe gateway attachments accepted from inbound gateways. */
export function isIngestableFile(file: InboundFile): boolean {
  return isAllowedIngestMime(file.mimetype);
}

/**
 * Fetch an allowlisted URL, following redirects manually so that EVERY hop's
 * host is validated against the Slack allowlist before it is fetched. This
 * makes "the bot-token Authorization header is only ever sent to allowlisted
 * slack.com hosts" an invariant of this function, rather than a property of
 * the runtime's cross-origin redirect header stripping.
 */
async function fetchFromAllowedHosts(
  initialUrl: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<Response> {
  let url = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isAllowedSlackFileUrl(url)) {
      throw new Error('download URL host not allowed');
    }
    const response = await fetchImpl(url, { headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await cancelResponseBody(response);
      if (!location) {
        throw new Error(`redirect (HTTP ${response.status}) without Location header`);
      }
      url = new URL(location, url).toString();
      continue;
    }
    return response;
  }
  throw new Error(`too many redirects (limit ${MAX_REDIRECT_HOPS})`);
}

/**
 * Buffer a response body while enforcing the byte ceiling on the ACTUAL bytes
 * received, aborting mid-stream the moment the running total exceeds it —
 * Content-Length can be absent or false, so the declared-size prechecks are
 * only cheap early-outs, never the bound.
 */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  // Throwing inside for-await invokes the iterator's return(), which cancels
  // the underlying stream — no bytes past the ceiling are buffered.
  for await (const chunk of response.body) {
    const buf = Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new Error(`downloaded size exceeds per-file limit ${maxBytes}`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Download the ingestable attachments of one inbound message and store them
 * in the upload directory. Never throws: every attachment that cannot be
 * fetched, validated, or written is counted in `failed` so the caller can
 * still deliver the prompt with a degradation note.
 */
export async function ingestInboundAttachments(args: {
  files: InboundFile[];
  botToken: string;
  fetchImpl?: typeof fetch;
  uploadDir?: string;
  maxTotalBytes?: number;
}): Promise<AttachmentIngestResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const uploadDir = args.uploadDir ?? getUploadDirectory();
  const requestedMaxTotalBytes = args.maxTotalBytes;
  const maxTotalBytes =
    typeof requestedMaxTotalBytes === 'number' && Number.isFinite(requestedMaxTotalBytes)
      ? Math.max(0, Math.min(requestedMaxTotalBytes, MAX_UPLOAD_TOTAL_SIZE))
      : MAX_UPLOAD_TOTAL_SIZE;

  const ingestable = args.files.filter(isIngestableFile);
  const paths: string[] = [];
  let failed = 0;
  let totalBytes = 0;

  for (const [index, file] of ingestable.entries()) {
    if (index >= MAX_UPLOAD_FILES_PER_REQUEST) {
      failed++;
      console.warn(
        `[gateway] Skipping attachment "${file.name}": message exceeds ${MAX_UPLOAD_FILES_PER_REQUEST}-file limit`
      );
      continue;
    }
    if (file.size > MAX_UPLOAD_FILE_SIZE) {
      failed++;
      console.warn(
        `[gateway] Skipping attachment "${file.name}": ${file.size} bytes exceeds per-file limit ${MAX_UPLOAD_FILE_SIZE}`
      );
      continue;
    }
    const remainingBytes = maxTotalBytes - totalBytes;
    if (remainingBytes <= 0) {
      failed++;
      console.warn(
        `[gateway] Skipping attachment "${file.name}": message exceeds aggregate size limit ${maxTotalBytes}`
      );
      continue;
    }
    if (!isAllowedSlackFileUrl(file.url_private_download)) {
      failed++;
      console.warn(`[gateway] Skipping attachment "${file.name}": download URL host not allowed`);
      continue;
    }

    try {
      const response = await fetchFromAllowedHosts(
        file.url_private_download,
        { Authorization: `Bearer ${args.botToken}` },
        fetchImpl
      );
      if (!response.ok) {
        await rejectResponse(response, `HTTP ${response.status}`);
      }
      // Slack answers with an HTML login/error page (status 200) when the
      // token lacks files:read or cannot see the file — only accept response
      // bodies whose type the ingestion pipeline allows (which excludes
      // text/html and script-bearing types like image/svg+xml).
      const contentType = response.headers.get('content-type') ?? '';
      if (!isAllowedIngestMime(contentType)) {
        await rejectResponse(
          response,
          `unexpected content-type ${contentType.split(';')[0].trim().toLowerCase() || 'unknown'}`
        );
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_FILE_SIZE) {
        await rejectResponse(response, `declared size ${declaredLength} exceeds per-file limit`);
      }
      if (Number.isFinite(declaredLength) && declaredLength > remainingBytes) {
        await rejectResponse(
          response,
          `declared size ${declaredLength} exceeds remaining message limit`
        );
      }
      const body = await readBodyWithLimit(
        response,
        Math.min(MAX_UPLOAD_FILE_SIZE, remainingBytes)
      );

      await fs.mkdir(uploadDir, { recursive: true });
      // Slack names every pasted screenshot "image.png"; prefix the unique
      // Slack file ID so same-millisecond downloads can never overwrite each
      // other (the timestamp in buildUploadFilename is not unique enough).
      const filePath = path.join(uploadDir, buildUploadFilename(`${file.id}_${file.name}`));
      await fs.writeFile(filePath, body);
      paths.push(filePath);
      totalBytes += body.byteLength;
    } catch (error) {
      failed++;
      console.warn(`[gateway] Failed to ingest attachment "${file.name}":`, error);
    }
  }

  return { paths, failed };
}
