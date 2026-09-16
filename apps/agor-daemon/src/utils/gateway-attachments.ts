/**
 * Server-side ingestion of inbound gateway message attachments.
 *
 * Downloads supported files attached to inbound gateway messages and stores
 * them in the existing tenant/session/branch upload staging layer. Slack
 * downloads use the channel's bot token; Discord downloads use the signed CDN
 * URL supplied by the provider and never receive a channel credential.
 *
 * Other attachment types (PDFs, office documents, archives, media) are out of
 * scope and never downloaded. Downloads are restricted to provider-owned URLs
 * and to the same per-file size / per-message count ceilings the upload route
 * enforces.
 */

import { Readable, Transform } from 'node:stream';
import type { InboundFile } from '@agor/core/gateway';
import { isAllowedDiscordAttachmentUrl } from '@agor/core/gateway';
import type {
  BranchID,
  SessionID,
  TenantID,
  UploadMetadata,
  UploadStagingStore,
  UserID,
} from '@agor/core/types';
import { buildUploadAttachmentPrompt } from '@agor/core/types';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  getUploadLimits,
  MAX_UPLOAD_FILES_PER_REQUEST,
} from './upload.js';
import { getUploadStagingStore } from './upload-staging.js';

export interface AttachmentIngestResult {
  /** Opaque logical records, in the order the attachments arrived. */
  uploads: UploadMetadata[];
  /** Ingestable attachments that could not be fetched or stored. */
  failed: number;
}

const MAX_REDIRECT_HOPS = 3;
const DISCORD_IMAGE_MIMES = new Set(['image/png', 'image/jpeg']);

/**
 * Whether a Slack file URL may be downloaded with the channel's bot token.
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
 * MIME types the ingestion pipeline accepts: images and text-like files
 * (logs, plain text, CSV, JSON, markdown) agents use as context. Constrained
 * to the upload route's allowlist, which deliberately excludes script-bearing
 * types like image/svg+xml; the image/text prefix check additionally keeps
 * allowlisted-but-unsupported types (PDFs, office documents, archives) out of
 * ingestion.
 */
function isAllowedIngestMime(rawMime: string): boolean {
  const mime = rawMime.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mime)) return false;
  return mime.startsWith('image/') || mime.startsWith('text/') || mime === 'application/json';
}

/** Image and text-like attachments the ingestion pipeline accepts. */
export function isIngestableFile(file: InboundFile): boolean {
  return isAllowedIngestMime(file.mimetype);
}

export function buildPromptWithAttachments(text: string, attachments: UploadMetadata[]): string {
  return buildUploadAttachmentPrompt(
    text,
    attachments.map(({ ref, name, mimeType, size }) => ({ ref, filename: name, mimeType, size }))
  );
}

/**
 * Fetch an allowlisted URL, following redirects manually so that EVERY hop's
 * URL is validated against the provider-specific allowlist before it is
 * fetched. This makes credential forwarding (where a provider requires it)
 * an invariant of this function, rather than a property of the runtime's
 * cross-origin redirect header stripping.
 */
async function fetchFromAllowedHosts(
  initialUrl: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  isAllowedUrl: (rawUrl: string) => boolean = isAllowedSlackFileUrl
): Promise<Response> {
  let url = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isAllowedUrl(url)) {
      throw new Error('download URL host not allowed');
    }
    const response = await fetchImpl(url, { headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
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

function discordImageMime(rawMime: string): string {
  return rawMime.split(';')[0].trim().toLowerCase();
}

/**
 * Download only the live Discord PNG/JPEG subset. Discord's URL is already
 * signed, so this path deliberately sends no Authorization header and
 * validates every manually-followed redirect against the same signed CDN
 * policy.
 */
export async function ingestDiscordInboundImages(args: {
  files: InboundFile[];
  fetchImpl?: typeof fetch;
  tenantId: TenantID;
  sessionId: SessionID;
  branchId: BranchID;
  createdBy: UserID;
  store?: UploadStagingStore;
}): Promise<AttachmentIngestResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const store = args.store ?? getUploadStagingStore();
  const limits = getUploadLimits();
  const uploads: UploadMetadata[] = [];
  let failed = 0;
  let declaredTotalBytes = 0;
  let actualTotalBytes = 0;

  for (const [index, file] of args.files.entries()) {
    if (index >= MAX_UPLOAD_FILES_PER_REQUEST) {
      failed++;
      console.warn(
        `[gateway] Skipping Discord attachment: message exceeds ${MAX_UPLOAD_FILES_PER_REQUEST}-file limit`
      );
      continue;
    }
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > limits.maxFileBytes ||
      file.size > limits.maxTotalBytes - declaredTotalBytes
    ) {
      failed++;
      console.warn(
        '[gateway] Skipping Discord attachment: declared size exceeds the upload limits'
      );
      continue;
    }
    if (
      (file.mimetype !== 'image/png' && file.mimetype !== 'image/jpeg') ||
      !isAllowedDiscordAttachmentUrl(file.url_private_download)
    ) {
      failed++;
      console.warn('[gateway] Skipping Discord attachment: unsupported type or URL');
      continue;
    }
    declaredTotalBytes += file.size;

    try {
      const response = await fetchFromAllowedHosts(
        file.url_private_download,
        {},
        fetchImpl,
        isAllowedDiscordAttachmentUrl
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = discordImageMime(response.headers.get('content-type') ?? '');
      if (!DISCORD_IMAGE_MIMES.has(contentType)) {
        throw new Error(`unexpected content-type ${contentType || 'unknown'}`);
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > limits.maxFileBytes) {
        throw new Error(`declared size ${declaredLength} exceeds per-file limit`);
      }
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > limits.maxTotalBytes - actualTotalBytes
      ) {
        throw new Error(`declared size ${declaredLength} exceeds total upload limit`);
      }
      if (!response.body) throw new Error('download response has no body');
      let fileBytes = 0;
      const source = Readable.fromWeb(response.body as never);
      const aggregateLimiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          fileBytes += chunk.byteLength;
          if (actualTotalBytes + fileBytes > limits.maxTotalBytes) {
            callback(
              Object.assign(new Error('Combined Discord attachment size exceeds upload limit'), {
                status: 413,
              })
            );
            return;
          }
          callback(null, chunk);
        },
      });
      source.pipe(aggregateLimiter);
      try {
        const staged = await store.stage({
          owner: {
            tenantId: args.tenantId,
            sessionId: args.sessionId,
            branchId: args.branchId,
            createdBy: args.createdBy,
          },
          name: `${file.id}_${file.name}`,
          mimeType: contentType,
          provenance: 'gateway-discord',
          body: aggregateLimiter,
          sizeHint: Number.isFinite(declaredLength) ? declaredLength : file.size,
        });
        actualTotalBytes += staged.size;
        uploads.push(staged);
      } finally {
        source.destroy();
        aggregateLimiter.destroy();
      }
    } catch (error) {
      failed++;
      console.warn('[gateway] Failed to ingest Discord attachment:', error);
    }
  }

  return { uploads, failed };
}

/**
 * Download the ingestable attachments of one inbound message and store them
 * in tenant-scoped staging. Never throws: every attachment that cannot be
 * fetched, validated, or written is counted in `failed` so the caller can
 * still deliver the prompt with a degradation note.
 */
export async function ingestInboundAttachments(args: {
  files: InboundFile[];
  botToken: string;
  fetchImpl?: typeof fetch;
  tenantId: TenantID;
  sessionId: SessionID;
  branchId: BranchID;
  createdBy: UserID;
  store?: UploadStagingStore;
}): Promise<AttachmentIngestResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const store = args.store ?? getUploadStagingStore();

  const ingestable = args.files.filter(isIngestableFile);
  const uploads: UploadMetadata[] = [];
  let failed = 0;

  for (const [index, file] of ingestable.entries()) {
    if (index >= MAX_UPLOAD_FILES_PER_REQUEST) {
      failed++;
      console.warn(
        `[gateway] Skipping attachment "${file.name}": message exceeds ${MAX_UPLOAD_FILES_PER_REQUEST}-file limit`
      );
      continue;
    }
    const maxFileBytes = getUploadLimits().maxFileBytes;
    if (file.size > maxFileBytes) {
      failed++;
      console.warn(
        `[gateway] Skipping attachment "${file.name}": ${file.size} bytes exceeds per-file limit ${maxFileBytes}`
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
        throw new Error(`HTTP ${response.status}`);
      }
      // Slack answers with an HTML login/error page (status 200) when the
      // token lacks files:read or cannot see the file — only accept response
      // bodies whose type the ingestion pipeline allows (which excludes
      // text/html and script-bearing types like image/svg+xml).
      const contentType = response.headers.get('content-type') ?? '';
      if (!isAllowedIngestMime(contentType)) {
        throw new Error(
          `unexpected content-type ${contentType.split(';')[0].trim().toLowerCase() || 'unknown'}`
        );
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > maxFileBytes) {
        throw new Error(`declared size ${declaredLength} exceeds per-file limit`);
      }
      if (!response.body) throw new Error('download response has no body');
      const staged = await store.stage({
        owner: {
          tenantId: args.tenantId,
          sessionId: args.sessionId,
          branchId: args.branchId,
          createdBy: args.createdBy,
        },
        name: `${file.id}_${file.name}`,
        mimeType: contentType.split(';')[0].trim().toLowerCase(),
        provenance: 'gateway-slack',
        body: Readable.fromWeb(response.body as never),
        sizeHint: Number.isFinite(declaredLength) ? declaredLength : file.size,
      });
      uploads.push(staged);
    } catch (error) {
      failed++;
      console.warn(`[gateway] Failed to ingest attachment "${file.name}":`, error);
    }
  }

  return { uploads, failed };
}
