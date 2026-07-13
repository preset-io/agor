import type { BranchID, LinkID, MessageID, SessionID, UserID, UUID } from './id';
import { extractKnowledgeLinks } from './knowledge';
import type { ContentBlock, Message } from './message';

export const LINK_KINDS = [
  'issue',
  'pr',
  'kb_ref',
  'internal',
  'image',
  'document',
  'url',
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_SOURCES = ['manual', 'parsed', 'upload'] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

export const LINK_OWNER_SCOPES = ['branch', 'session', 'all'] as const;
export type LinkOwnerScope = (typeof LINK_OWNER_SCOPES)[number];

export const LINK_TARGET_FIELDS = ['url', 'ref_uri', 'file_path'] as const;
export type LinkTargetField = (typeof LINK_TARGET_FIELDS)[number];

export const MAX_PARSED_LINKS_PER_MESSAGE = 100;

export const LINK_TARGET_OBJECT_TYPES = [
  'artifact',
  'board',
  'branch',
  'card',
  'knowledge_document',
  'knowledge_namespace',
  'message',
  'mcp_server',
  'repo',
  'session',
  'task',
  'user',
] as const;
export type LinkTargetObjectType = (typeof LINK_TARGET_OBJECT_TYPES)[number];

export const LINK_KIND_TARGET_FIELD = {
  issue: 'url',
  pr: 'url',
  url: 'url',
  kb_ref: 'ref_uri',
  internal: 'ref_uri',
  image: 'file_path',
  document: 'file_path',
} as const satisfies Record<LinkKind, LinkTargetField>;

export const LINK_SOURCE_TARGET_FIELDS = {
  upload: ['file_path'],
  parsed: ['url', 'ref_uri'],
  manual: LINK_TARGET_FIELDS,
} as const satisfies Record<LinkSource, readonly LinkTargetField[]>;

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
  target_object_type?: LinkTargetObjectType | null;
  target_object_id?: UUID | null;
  target_key: string;
  is_pinned: boolean;
  title?: string | null;
  mime_type?: string | null;
  metadata?: LinkMetadata | null;
  created_by?: UserID | null;
  created_at: string;
  updated_at: string;
  /** Monotonic per-row version used to order HTTP and realtime results. */
  revision?: number;
}

export type LinkOwner =
  | { branch_id: BranchID; session_id?: null }
  | { branch_id?: null; session_id: SessionID };

export type LinkTarget =
  | {
      url: string;
      ref_uri?: null;
      file_path?: null;
      target_object_type?: null;
      target_object_id?: null;
    }
  | {
      url?: null;
      ref_uri: string;
      file_path?: null;
      target_object_type?: LinkTargetObjectType | null;
      target_object_id?: UUID | null;
    }
  | {
      url?: null;
      ref_uri?: null;
      file_path: string;
      target_object_type?: null;
      target_object_id?: null;
    };

export type LinkCreate = LinkOwner &
  LinkTarget & {
    link_id?: LinkID;
    source_message_id?: MessageID | null;
    kind: LinkKind;
    source: LinkSource;
    is_pinned?: boolean;
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
    | 'target_object_type'
    | 'target_object_id'
    | 'is_pinned'
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
  target_object_type?: LinkTargetObjectType | null;
  target_object_id?: UUID | null;
  title?: string | null;
  metadata?: LinkMetadata | null;
}

const HTTP_URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?\]}]+$/;
const GITHUB_ISSUE_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+(?:[/?#].*)?$/i;
const GITHUB_PR_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/i;

function stripUnmatchedTrailingParentheses(value: string): string {
  let result = value.replace(TRAILING_PUNCTUATION_RE, '');
  let openingCount = 0;
  let closingCount = 0;
  for (const character of result) {
    if (character === '(') openingCount += 1;
    else if (character === ')') closingCount += 1;
  }
  while (result.endsWith(')') && closingCount > openingCount) {
    result = result.slice(0, -1);
    closingCount -= 1;
  }
  return result;
}

function stripMarkdownFencedCode(text: string): string {
  let fence: { character: string; length: number } | null = null;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimStart();
      const marker = trimmed.match(/^(`{3,}|~{3,})/)?.[1] ?? null;
      if (fence) {
        if (
          marker?.[0] === fence.character &&
          marker.length >= fence.length &&
          trimmed.slice(marker.length).trim() === ''
        ) {
          fence = null;
        }
        return '';
      }
      if (marker) {
        fence = { character: marker[0], length: marker.length };
        return '';
      }
      return line;
    })
    .join('\n');
}

function stripMarkdownInlineCode(text: string): string {
  const runs = Array.from(text.matchAll(/`+/g), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    length: match[0].length,
  }));
  const nextRunWithLength = new Array<number>(runs.length).fill(-1);
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    nextRunWithLength[index] = nextByLength.get(runs[index].length) ?? -1;
    nextByLength.set(runs[index].length, index);
  }

  let result = '';
  let cursor = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const closingIndex = nextRunWithLength[index];
    if (closingIndex === -1) continue;
    const opener = runs[index];
    const closer = runs[closingIndex];
    result += text.slice(cursor, opener.start);
    result += text.slice(opener.start, closer.end).replace(/[^\r\n]/g, ' ');
    cursor = closer.end;
    index = closingIndex;
  }
  return result + text.slice(cursor);
}

function stripMarkdownCode(text: string): string {
  return stripMarkdownInlineCode(stripMarkdownFencedCode(text));
}

export function isLinkKind(value: unknown): value is LinkKind {
  return typeof value === 'string' && (LINK_KINDS as readonly string[]).includes(value);
}

export function isLinkSource(value: unknown): value is LinkSource {
  return typeof value === 'string' && (LINK_SOURCES as readonly string[]).includes(value);
}

export function isLinkTargetObjectType(value: unknown): value is LinkTargetObjectType {
  return (
    typeof value === 'string' && (LINK_TARGET_OBJECT_TYPES as readonly string[]).includes(value)
  );
}

export function isInternalLinkData(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    data.kind === 'internal' || data.target_object_type != null || data.target_object_id != null
  );
}

export function getLinkTargetField(data: {
  url?: string | null;
  ref_uri?: string | null;
  file_path?: string | null;
}): LinkTargetField | null {
  if (data.url?.trim()) return 'url';
  if (data.ref_uri?.trim()) return 'ref_uri';
  if (data.file_path?.trim()) return 'file_path';
  return null;
}

export function countLinkTargets(data: {
  url?: string | null;
  ref_uri?: string | null;
  file_path?: string | null;
}): number {
  return LINK_TARGET_FIELDS.filter((field) => {
    const value = data[field];
    return typeof value === 'string' && value.trim() !== '';
  }).length;
}

export function getLinkTargetCompatibilityError(data: {
  kind: LinkKind;
  source: LinkSource;
  url?: string | null;
  ref_uri?: string | null;
  file_path?: string | null;
  target_object_type?: LinkTargetObjectType | string | null;
  target_object_id?: UUID | string | null;
}): string | null {
  const target = getLinkTargetField(data);
  if (!target) {
    return 'Link requires a target: url, ref_uri, or file_path';
  }

  const expectedKindTarget = LINK_KIND_TARGET_FIELD[data.kind];
  if (target !== expectedKindTarget) {
    return `Link kind ${data.kind} requires target ${expectedKindTarget}`;
  }

  if (!LINK_SOURCE_TARGET_FIELDS[data.source].some((field) => field === target)) {
    return `Link source ${data.source} cannot use target ${target}`;
  }

  const hasObjectType = Boolean(data.target_object_type);
  const hasObjectId = Boolean(data.target_object_id);
  if (hasObjectType !== hasObjectId) {
    return 'Link target_object_type and target_object_id must be provided together';
  }

  if (hasObjectType && !isLinkTargetObjectType(data.target_object_type)) {
    return `Invalid link target_object_type: ${data.target_object_type}`;
  }

  if (hasObjectType && target !== 'ref_uri') {
    return 'Internal object references require target ref_uri';
  }

  if (hasObjectType && !data.ref_uri?.trim().toLowerCase().startsWith('agor://')) {
    return 'Internal object references require an agor:// ref_uri';
  }

  if (data.kind === 'kb_ref' && !data.ref_uri?.trim().toLowerCase().startsWith('agor://kb/')) {
    return 'Knowledge links require an agor://kb/ ref_uri';
  }

  if (data.kind === 'internal' && (!hasObjectType || !hasObjectId)) {
    return 'Internal links require target_object_type and target_object_id';
  }

  return null;
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
    return `url:${stripUnmatchedTrailingParentheses(url.trim())}`;
  }
}

export function normalizeRefTargetKey(refUri: string): string {
  const trimmed = refUri.trim();
  const hierarchicalUri = trimmed.match(/^([a-z][a-z\d+.-]*):\/\/([^/]*)(.*)$/i);
  if (!hierarchicalUri) return `ref:${trimmed}`;

  const [, scheme, authority, pathAndSuffix] = hierarchicalUri;
  return `ref:${scheme.toLowerCase()}://${authority.toLowerCase()}${pathAndSuffix}`;
}

export function normalizeFileTargetKey(filePath: string): string {
  return `file:${filePath.trim()}`;
}

export const TEAMMATE_PROMOTION_METADATA_KEY = 'teammate_promotion';

export function isTeammatePromotionLink(link: Pick<Link, 'metadata'>): boolean {
  const metadata = link.metadata;
  return Boolean(
    metadata &&
      (metadata[TEAMMATE_PROMOTION_METADATA_KEY] === true ||
        (metadata.promoted_from_owner && typeof metadata.promoted_from_owner === 'object'))
  );
}

export function normalizeLinkTargetKey(data: {
  url?: string | null;
  ref_uri?: string | null;
  file_path?: string | null;
  target_object_type?: LinkTargetObjectType | string | null;
  target_object_id?: UUID | string | null;
}): string | null {
  if (data.target_object_type && data.target_object_id) {
    return `object:${String(data.target_object_type).trim().toLowerCase()}:${String(
      data.target_object_id
    )
      .trim()
      .toLowerCase()}`;
  }
  const target = getLinkTargetField(data);
  if (target === 'url' && data.url) return normalizeUrlTargetKey(data.url);
  if (target === 'ref_uri' && data.ref_uri) return normalizeRefTargetKey(data.ref_uri);
  if (target === 'file_path' && data.file_path) return normalizeFileTargetKey(data.file_path);
  return null;
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

  for (const rawText of textParts) {
    const text = stripMarkdownCode(rawText);
    for (const ref of extractKnowledgeLinks(text)) {
      const refUri =
        'document_id' in ref && ref.document_id
          ? `agor://kb/document/${ref.document_id}`
          : `agor://kb/${ref.namespace_slug}/${ref.path}`;
      const targetKey = normalizeRefTargetKey(refUri);
      if (seen.has(targetKey)) continue;
      seen.add(targetKey);
      drafts.push({
        kind: 'kb_ref',
        source: 'parsed',
        ref_uri: refUri,
      });
    }

    for (const match of text.matchAll(HTTP_URL_RE)) {
      const url = stripUnmatchedTrailingParentheses(match[0]);
      const targetKey = normalizeUrlTargetKey(url);
      if (seen.has(targetKey)) continue;
      seen.add(targetKey);
      drafts.push({
        kind: GITHUB_ISSUE_RE.test(url) ? 'issue' : GITHUB_PR_RE.test(url) ? 'pr' : 'url',
        source: 'parsed',
        url,
      });
    }
  }

  return drafts;
}
