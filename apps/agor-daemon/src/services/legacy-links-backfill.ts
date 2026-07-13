import fs from 'node:fs/promises';
import path from 'node:path';
import { LinksRepository, MessagesRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { LinkCreate, Message, SessionID, UUID } from '@agor/core/types';
import {
  extractLinksFromMessage,
  extractMessageTextContent,
  MAX_PARSED_LINKS_PER_MESSAGE,
  normalizeFileTargetKey,
  normalizeRefTargetKey,
  normalizeUrlTargetKey,
} from '@agor/core/types';
import { isPathInsideRoot } from '../utils/branch-workspace-path.js';
import { getUploadDirectory } from '../utils/upload.js';

const LEGACY_ATTACHMENT_HEADING = /^Attached files:\s*$/i;
const LEGACY_ATTACHMENT_ITEM = /^\s*[-*+]\s+(.+?)\s*$/;
const LEGACY_UPLOAD_NOTE = /(?:^|\n)(?:note:\s*)?the user uploaded file\(s\):\s*([^\n]+)/gi;
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
    for (const match of text.matchAll(LEGACY_UPLOAD_NOTE)) {
      for (const value of match[1].split(/,\s+/).map(stripPathQuotes)) {
        if (value) paths.push(value);
      }
    }
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

function looksLikeLegacyUploadPath(value: string): boolean {
  return /(^|[\\/])\.agor[\\/]uploads[\\/]/i.test(value) || /(^|[\\/])uploads[\\/]/i.test(value);
}

async function resolveLegacyUpload(
  rawPath: string,
  uploadRoot: string,
  uploadRootReal: string
): Promise<{ filePath: string; title: string; mimeType: string } | null> {
  const legacyUploadPath = looksLikeLegacyUploadPath(rawPath);
  if (!legacyUploadPath && !path.isAbsolute(rawPath)) return null;

  const directCandidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : null;
  const basename = path.basename(rawPath);
  if (!basename || basename === '.' || basename === path.sep) return null;
  const candidates = [
    directCandidate,
    legacyUploadPath ? path.join(uploadRoot, basename) : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || !isPathInsideRoot(uploadRootReal, real, { allowRoot: true })) continue;
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
 * idempotent, and the caller keeps a bounded short-lived cache so ordinary
 * owner hydration avoids repeated scans without retaining arbitrary owners.
 */
export async function backfillLegacySessionLinks(args: {
  db: TenantScopeAwareDatabase;
  sessionId: SessionID;
  uploadRoot?: string;
  visibleToUserId?: UUID;
}): Promise<boolean> {
  const messages = await new MessagesRepository(args.db).findAll({
    sessionId: args.sessionId,
    visibleToUserId: args.visibleToUserId,
  });
  if (messages.length === 0) return false;

  const linksRepository = new LinksRepository(args.db);
  const existingTargetKeys = new Set(
    (await linksRepository.findAll({ sessionId: args.sessionId })).map((link) => link.target_key)
  );
  const uploadRoot = args.uploadRoot ?? getUploadDirectory();
  const uploadRootReal = await fs.realpath(uploadRoot).catch(() => null);
  const drafts: Partial<LinkCreate>[] = [];

  for (const message of messages) {
    for (const parsed of extractLinksFromMessage(message).slice(0, MAX_PARSED_LINKS_PER_MESSAGE)) {
      const targetKey = parsed.url
        ? normalizeUrlTargetKey(parsed.url)
        : normalizeRefTargetKey(parsed.ref_uri ?? '');
      if (existingTargetKeys.has(targetKey)) continue;
      existingTargetKeys.add(targetKey);
      drafts.push({
        ...parsed,
        session_id: args.sessionId,
        branch_id: null,
        source_message_id: message.message_id,
        created_by: null,
      } as Partial<LinkCreate>);
    }

    if (!uploadRootReal) continue;
    for (const legacyPath of extractLegacyAttachmentPaths(message).slice(0, 10)) {
      const upload = await resolveLegacyUpload(legacyPath, uploadRoot, uploadRootReal);
      if (!upload) continue;
      const targetKey = normalizeFileTargetKey(upload.filePath);
      if (existingTargetKeys.has(targetKey)) continue;
      existingTargetKeys.add(targetKey);
      drafts.push({
        session_id: args.sessionId,
        branch_id: null,
        source_message_id: message.message_id,
        source: 'upload',
        kind: upload.mimeType.startsWith('image/') ? 'image' : 'document',
        file_path: upload.filePath,
        title: upload.title,
        mime_type: upload.mimeType,
        metadata: { legacy_backfill: true },
        created_by: null,
      });
    }
  }

  await linksRepository.upsertManyWithStatus(drafts);
  return true;
}
