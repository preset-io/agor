/**
 * Server-side ingestion of inbound gateway message attachments.
 *
 * Downloads image files attached to inbound Slack messages using the
 * channel's bot token and stores them in the daemon upload directory — the
 * same destination the session composer's `/sessions/:sessionId/upload`
 * route writes to — so the session's agent can Read them by absolute path.
 *
 * Non-image attachments are out of scope and never downloaded. Downloads are
 * restricted to Slack-owned hosts and to the same per-file size / per-message
 * count ceilings the upload route enforces.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { InboundFile } from '@agor/core/gateway';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  buildUploadFilename,
  getUploadDirectory,
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILES_PER_REQUEST,
} from './upload.js';

export interface AttachmentIngestResult {
  /** Absolute paths of stored files, in the order the attachments arrived. */
  paths: string[];
  /** Image attachments that could not be fetched or stored. */
  failed: number;
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

/** Image attachments the upload pipeline accepts (same allowlist as the upload route). */
export function isIngestableImageFile(file: InboundFile): boolean {
  const mime = file.mimetype.split(';')[0].trim().toLowerCase();
  return mime.startsWith('image/') && ALLOWED_UPLOAD_MIME_TYPES.has(mime);
}

/**
 * Fold stored attachment paths into a prompt.
 *
 * Server-side copy of the session composer's `buildPromptWithAttachments`
 * (`apps/agor-ui/src/components/SessionPanel/composerAttachments.ts`) — the
 * daemon must not import agor-ui. Keep the two in sync.
 */
export function buildPromptWithAttachments(text: string, attachmentPaths: string[]): string {
  const trimmedText = text.trim();
  if (attachmentPaths.length === 0) return trimmedText;

  const attachmentBlock = [
    'Attached files:',
    ...attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
  ].join('\n');
  if (trimmedText.startsWith('/')) {
    return `${trimmedText}\n\n${attachmentBlock}`;
  }
  return trimmedText ? `${attachmentBlock}\n\n${trimmedText}` : attachmentBlock;
}

/**
 * Download the image attachments of one inbound message and store them in the
 * upload directory. Never throws: every attachment that cannot be fetched,
 * validated, or written is counted in `failed` so the caller can still
 * deliver the prompt with a degradation note.
 */
export async function ingestInboundImageAttachments(args: {
  files: InboundFile[];
  botToken: string;
  fetchImpl?: typeof fetch;
  uploadDir?: string;
}): Promise<AttachmentIngestResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const uploadDir = args.uploadDir ?? getUploadDirectory();

  const images = args.files.filter(isIngestableImageFile);
  const paths: string[] = [];
  let failed = 0;

  for (const [index, file] of images.entries()) {
    if (index >= MAX_UPLOAD_FILES_PER_REQUEST) {
      failed++;
      console.warn(
        `[gateway] Skipping attachment "${file.name}": message exceeds ${MAX_UPLOAD_FILES_PER_REQUEST}-image limit`
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
    if (!isAllowedSlackFileUrl(file.url_private_download)) {
      failed++;
      console.warn(`[gateway] Skipping attachment "${file.name}": download URL host not allowed`);
      continue;
    }

    try {
      const response = await fetchImpl(file.url_private_download, {
        headers: { Authorization: `Bearer ${args.botToken}` },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      // Slack answers with an HTML login/error page (status 200) when the
      // token lacks files:read or cannot see the file — only accept images.
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!contentType.startsWith('image/')) {
        throw new Error(`unexpected content-type ${contentType || 'unknown'}`);
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_FILE_SIZE) {
        throw new Error(`declared size ${declaredLength} exceeds per-file limit`);
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > MAX_UPLOAD_FILE_SIZE) {
        throw new Error(`downloaded size ${body.byteLength} exceeds per-file limit`);
      }

      await fs.mkdir(uploadDir, { recursive: true });
      const filePath = path.join(uploadDir, buildUploadFilename(file.name));
      await fs.writeFile(filePath, body);
      paths.push(filePath);
    } catch (error) {
      failed++;
      console.warn(`[gateway] Failed to ingest attachment "${file.name}":`, error);
    }
  }

  return { paths, failed };
}
