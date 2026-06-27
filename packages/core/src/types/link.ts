import type { BranchID, LinkID, MessageID, SessionID, UserID } from './id';
import { extractKnowledgeLinks } from './knowledge';
import type { ContentBlock, Message } from './message';

export const LINK_KINDS = ['issue', 'pr', 'kb_ref', 'image', 'document', 'url'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_SOURCES = ['manual', 'parsed', 'upload'] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

export interface LinkMetadata {
  [key: string]: unknown;
}

export interface Link {
  link_id: LinkID;
  branch_id?: BranchID | null;
  session_id?: SessionID | null;
  source_message_id?: MessageID | null;
  kind: LinkKind;
  source: LinkSource;
  url?: string | null;
  ref_uri?: string | null;
  file_path?: string | null;
  target_key: string;
  title?: string | null;
  mime_type?: string | null;
  metadata?: LinkMetadata | null;
  created_by?: UserID | null;
  created_at: string;
  updated_at: string;
}

export type LinkOwner =
  | { branch_id: BranchID; session_id?: null }
  | { branch_id?: null; session_id: SessionID };

export type LinkTarget =
  | { url: string; ref_uri?: null; file_path?: null }
  | { url?: null; ref_uri: string; file_path?: null }
  | { url?: null; ref_uri?: null; file_path: string };

export type LinkCreate = LinkOwner &
  LinkTarget & {
    link_id?: LinkID;
    source_message_id?: MessageID | null;
    kind: LinkKind;
    source: LinkSource;
    target_key?: string;
    title?: string | null;
    mime_type?: string | null;
    metadata?: LinkMetadata | null;
    created_by?: UserID | null;
  };

export type LinkPatch = Partial<
  Pick<
    Link,
    | 'kind'
    | 'source'
    | 'url'
    | 'ref_uri'
    | 'file_path'
    | 'target_key'
    | 'title'
    | 'mime_type'
    | 'metadata'
    | 'source_message_id'
  >
>;

export interface ParsedLinkDraft {
  kind: LinkKind;
  source: 'parsed';
  url?: string | null;
  ref_uri?: string | null;
  target_key: string;
  title?: string | null;
  metadata?: LinkMetadata | null;
}

const HTTP_URL_RE = /https?:\/\/[^\s<>"')]+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?\]}]+$/;
const GITHUB_ISSUE_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+(?:[/?#].*)?$/i;
const GITHUB_PR_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/i;

export function isLinkKind(value: unknown): value is LinkKind {
  return typeof value === 'string' && (LINK_KINDS as readonly string[]).includes(value);
}

export function isLinkSource(value: unknown): value is LinkSource {
  return typeof value === 'string' && (LINK_SOURCES as readonly string[]).includes(value);
}

export function normalizeUrlTargetKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return `url:${parsed.toString()}`;
  } catch {
    return `url:${url.trim().replace(TRAILING_PUNCTUATION_RE, '')}`;
  }
}

export function normalizeRefTargetKey(refUri: string): string {
  return `ref:${refUri.trim().toLowerCase()}`;
}

export function normalizeFileTargetKey(filePath: string): string {
  return `file:${filePath.trim()}`;
}

export function buildKnowledgeRefUri(
  ref: ReturnType<typeof extractKnowledgeLinks>[number]
): string {
  if ('document_id' in ref && ref.document_id) {
    return `agor://kb/document/${ref.document_id}`;
  }
  return `agor://kb/${ref.namespace_slug}/${ref.path}`;
}

export function classifyUrlKind(url: string): LinkKind {
  if (GITHUB_ISSUE_RE.test(url)) return 'issue';
  if (GITHUB_PR_RE.test(url)) return 'pr';
  return 'url';
}

export function extractMessageTextContent(message: Pick<Message, 'content'>): string[] {
  const { content } = message;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];

  return content.flatMap((block: ContentBlock) => {
    if (block.type !== 'text') return [];
    const text = block.text;
    return typeof text === 'string' ? [text] : [];
  });
}

export function extractLinksFromMessage(message: Pick<Message, 'content'>): ParsedLinkDraft[] {
  const textParts = extractMessageTextContent(message);
  const drafts: ParsedLinkDraft[] = [];
  const seen = new Set<string>();

  for (const text of textParts) {
    for (const ref of extractKnowledgeLinks(text)) {
      const refUri = buildKnowledgeRefUri(ref);
      const targetKey = normalizeRefTargetKey(refUri);
      if (seen.has(targetKey)) continue;
      seen.add(targetKey);
      drafts.push({
        kind: 'kb_ref',
        source: 'parsed',
        ref_uri: refUri,
        target_key: targetKey,
      });
    }

    for (const match of text.matchAll(HTTP_URL_RE)) {
      const url = match[0].replace(TRAILING_PUNCTUATION_RE, '');
      const targetKey = normalizeUrlTargetKey(url);
      if (seen.has(targetKey)) continue;
      seen.add(targetKey);
      drafts.push({
        kind: classifyUrlKind(url),
        source: 'parsed',
        url,
        target_key: targetKey,
      });
    }
  }

  return drafts;
}
