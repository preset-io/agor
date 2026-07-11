import fs from 'node:fs/promises';
import path from 'node:path';
import { LinksRepository, MessagesRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { LinkCreate, Message, SessionID, UUID } from '@agor/core/types';
import { extractLinksFromMessage, extractMessageTextContent } from '@agor/core/types';
import { getUploadDirectory } from '../utils/upload.js';

const LEGACY_ATTACHMENT_HEADING = /^Attached files:\s*$/i;
const LEGACY_ATTACHMENT_ITEM = /^\s*[-*+]\s+(.+?)\s*$/;
const MAX_PARSED_LINKS_PER_MESSAGE = 100;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
};

function stripPathQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function extractLegacyAttachmentPaths(message: Pick<Message, 'content'>): string[] {
  const paths: string[] = [];
  for (const text of extractMessageTextContent(message)) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!LEGACY_ATTACHMENT_HEADING.test(lines[index].trim())) continue;
      for (let itemIndex = index + 1; itemIndex < lines.length; itemIndex += 1) {
        const match = lines[itemIndex].match(LEGACY_ATTACHMENT_ITEM);
        if (!match) break;
        const value = stripPathQuotes(match[1]);
        if (value) paths.push(value);
      }
    }
  }
  return [...new Set(paths)];
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function looksLikeLegacyUploadPath(value: string): boolean {
  return /(^|[\\/])\.agor[\\/]uploads[\\/]/i.test(value) || /(^|[\\/])uploads[\\/]/i.test(value);
}

async function resolveLegacyUpload(
  rawPath: string,
  uploadRoot: string,
  uploadRootReal: string
): Promise<{ filePath: string; title: string; mimeType: string } | null> {
  if (!looksLikeLegacyUploadPath(rawPath) && !path.isAbsolute(rawPath)) return null;

  const directCandidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : null;
  const basename = path.basename(rawPath);
  if (!basename || basename === '.' || basename === path.sep) return null;
  const candidates = [directCandidate, path.join(uploadRoot, basename)].filter(
    (candidate): candidate is string => Boolean(candidate)
  );

  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || !isInside(uploadRootReal, real)) continue;
    const title = path.basename(real);
    const mimeType =
      MIME_BY_EXTENSION[path.extname(title).toLowerCase()] ?? 'application/octet-stream';
    return { filePath: title, title, mimeType };
  }
  return null;
}

/**
 * Lazily reconcile pre-links messages for one session. This keeps upgrades
 * compatible without a global startup scan on large installations. Upserts are
 * idempotent, and the caller memoizes successful session scans for this daemon
 * process so ordinary owner hydration pays the cost only once.
 */
export async function backfillLegacySessionLinks(args: {
  db: TenantScopeAwareDatabase;
  sessionId: SessionID;
  uploadRoot?: string;
  visibleToUserId?: UUID;
}): Promise<void> {
  const messages = await new MessagesRepository(args.db).findAll({
    sessionId: args.sessionId,
    visibleToUserId: args.visibleToUserId,
  });
  if (messages.length === 0) return;

  const linksRepository = new LinksRepository(args.db);
  const uploadRoot = args.uploadRoot ?? getUploadDirectory();
  const uploadRootReal = await fs.realpath(uploadRoot).catch(() => null);
  const drafts: Partial<LinkCreate>[] = [];

  for (const message of messages) {
    for (const parsed of extractLinksFromMessage(message).slice(0, MAX_PARSED_LINKS_PER_MESSAGE)) {
      const target = parsed.url ? { url: parsed.url } : { ref_uri: parsed.ref_uri };
      const existing = await linksRepository.findByOwnerAndTarget({
        session_id: args.sessionId,
        branch_id: null,
        ...target,
      });
      if (!existing) {
        drafts.push({
          ...parsed,
          session_id: args.sessionId,
          branch_id: null,
          source_message_id: message.message_id,
          created_by: null,
        } as Partial<LinkCreate>);
      }
    }

    if (!uploadRootReal) continue;
    for (const legacyPath of extractLegacyAttachmentPaths(message).slice(0, 10)) {
      const upload = await resolveLegacyUpload(legacyPath, uploadRoot, uploadRootReal);
      if (!upload) continue;
      const existing = await linksRepository.findByOwnerAndTarget({
        session_id: args.sessionId,
        branch_id: null,
        file_path: upload.filePath,
      });
      if (!existing) {
        drafts.push({
          session_id: args.sessionId,
          branch_id: null,
          source_message_id: message.message_id,
          source: 'upload',
          kind: upload.mimeType.startsWith('image/') ? 'image' : 'document',
          file_path: upload.filePath,
          title: upload.title,
          mime_type: upload.mimeType,
          metadata: { legacy_backfill: true, originalPath: legacyPath },
          created_by: null,
        });
      }
    }
  }

  // A message may repeat the same target. Preserve first-message attribution,
  // matching the repository's normal dedupe contract, before entering the
  // transactional batch.
  const uniqueDrafts = new Map<string, Partial<LinkCreate>>();
  for (const draft of drafts) {
    const key = draft.url
      ? `url:${draft.url}`
      : draft.ref_uri
        ? `ref:${draft.ref_uri}`
        : `file:${draft.file_path}`;
    if (!uniqueDrafts.has(key)) uniqueDrafts.set(key, draft);
  }
  await linksRepository.upsertManyWithStatus([...uniqueDrafts.values()]);
}
