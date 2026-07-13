import type { Branch, Link, LinkKind, LinkSource } from '@agor-live/client';
import {
  isTeammatePromotionLink,
  normalizeFileTargetKey,
  normalizeRefTargetKey,
  normalizeUrlTargetKey,
} from '@agor-live/client';
import {
  buildKnowledgeRoutePath,
  KNOWLEDGE_DOCUMENT_ID_ROUTE_NAMESPACE,
  knowledgeDocumentIdFromRoute,
} from '../../utils/knowledgeRoutes';
import { getUrlDisplayLabel } from '../Pill/url-helpers';

export type LinkDisplayCategory =
  | 'knowledge'
  | 'image'
  | 'pdf'
  | 'spreadsheet'
  | 'csv'
  | 'document'
  | 'markdown'
  | 'text'
  | 'code'
  | 'json'
  | 'log'
  | 'url'
  | 'issue'
  | 'pr'
  | 'internal'
  | 'unknown';

export type LinkDisplayNavigation = 'external' | 'spa';
type LinkDisplaySource = LinkSource | 'branch';

export interface LinkDisplayTarget {
  href: string;
  navigation: LinkDisplayNavigation;
}

export interface LinkDisplayItem {
  key: string;
  name: string;
  targetKey: string;
  category: LinkDisplayCategory;
  kind?: LinkKind;
  source?: LinkDisplaySource;
  ownerScope: 'branch' | 'session';
  isPinned: boolean;
  isPromoted?: boolean;
  url?: string;
  refUri?: string;
  filePath?: string;
  mimeType?: string;
  linkId?: string;
  sessionId?: string;
  sourceSessionId?: string;
  href?: string;
  navigation?: LinkDisplayNavigation;
  createdAt?: string;
  updatedAt?: string;
}

const KB_URI_PREFIX = 'agor://kb/';
const KB_DOCUMENT_URI_PREFIX = 'agor://kb/document/';
const KB_UNIT_URI_PREFIX = 'agor://kb/unit/';
const SAFE_WEB_PROTOCOLS = new Set(['http:', 'https:']);
export const FILE_LINK_CATEGORIES = new Set<LinkDisplayCategory>([
  'image',
  'pdf',
  'spreadsheet',
  'csv',
  'document',
  'markdown',
  'text',
  'code',
  'json',
  'log',
]);
const CODE_EXTENSIONS = new Set(
  'js jsx ts tsx py rb go rs java c cc cpp h hpp css scss html xml yaml yml toml sql sh zsh'.split(
    ' '
  )
);
const GLYPH_LABELS: Record<LinkDisplayCategory, string> = {
  knowledge: 'KB',
  image: 'IMG',
  pdf: 'PDF',
  spreadsheet: 'XLS',
  csv: 'CSV',
  document: 'DOC',
  markdown: 'MD',
  text: 'TXT',
  code: 'CODE',
  json: 'JSON',
  log: 'LOG',
  issue: 'ISSUE',
  pr: 'PR',
  url: 'URL',
  internal: 'REF',
  unknown: 'LINK',
};

function startsWithIgnoreCase(value: string, prefix: string): boolean {
  return value.slice(0, prefix.length).toLowerCase() === prefix;
}

function cleanSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeWebUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return SAFE_WEB_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function lastPathSegment(value: string): string {
  const cleaned = value.split(/[?#]/)[0] ?? value;
  const parts = cleaned.split('/').filter(Boolean);
  return parts.at(-1) || value;
}

function urlWithoutProtocol(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return value.replace(/^https?:\/\//i, '');
  }
}

function extensionFromPath(value?: string | null): string {
  const segment = lastPathSegment(value ?? '');
  const dot = segment.lastIndexOf('.');
  return dot >= 0 ? segment.slice(dot + 1).toLowerCase() : '';
}

function titleOrNull(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function githubKindLabel(kind?: LinkKind): 'Issue' | 'PR' | null {
  if (kind === 'issue') return 'Issue';
  if (kind === 'pr') return 'PR';
  return null;
}

export function routeForKnowledgeRefUri(refUri?: string | null, basePath = '/kb'): string | null {
  const trimmed = refUri?.trim();
  if (!trimmed || !startsWithIgnoreCase(trimmed, KB_URI_PREFIX)) return null;
  if (startsWithIgnoreCase(trimmed, KB_DOCUMENT_URI_PREFIX)) {
    const documentId = knowledgeDocumentIdFromRoute(
      KNOWLEDGE_DOCUMENT_ID_ROUTE_NAMESPACE,
      trimmed.slice(KB_DOCUMENT_URI_PREFIX.length)
    );
    return documentId
      ? buildKnowledgeRoutePath(basePath, KNOWLEDGE_DOCUMENT_ID_ROUTE_NAMESPACE, documentId)
      : null;
  }
  if (startsWithIgnoreCase(trimmed, KB_UNIT_URI_PREFIX)) return null;

  const rest = trimmed.slice(KB_URI_PREFIX.length);
  const [namespaceSlug, ...pathParts] = rest.split('/').filter(Boolean).map(cleanSegment);
  if (!namespaceSlug || ['document', 'unit'].includes(namespaceSlug.toLowerCase())) return null;

  return buildKnowledgeRoutePath(basePath, namespaceSlug, pathParts.join('/') || null);
}

export function targetForLinkDisplay(args: {
  url?: string | null;
  refUri?: string | null;
}): LinkDisplayTarget | null {
  const route = routeForKnowledgeRefUri(args.refUri);
  if (route) return { href: route, navigation: 'spa' };
  const safeUrl = safeWebUrl(args.url);
  if (safeUrl) return { href: safeUrl, navigation: 'external' };
  return null;
}

function getRefDisplayLabel(refUri: string): string {
  const trimmed = refUri.trim();
  if (startsWithIgnoreCase(trimmed, KB_DOCUMENT_URI_PREFIX)) {
    return `KB document ${trimmed.slice(KB_DOCUMENT_URI_PREFIX.length, KB_DOCUMENT_URI_PREFIX.length + 8)}`;
  }
  if (startsWithIgnoreCase(trimmed, KB_UNIT_URI_PREFIX)) {
    return `KB unit ${trimmed.slice(KB_UNIT_URI_PREFIX.length, KB_UNIT_URI_PREFIX.length + 8)}`;
  }
  if (startsWithIgnoreCase(trimmed, KB_URI_PREFIX)) {
    return `KB: ${trimmed.slice(KB_URI_PREFIX.length)}`;
  }
  return `Ref: ${trimmed}`;
}

export function getLinkDisplayCategory(args: {
  kind?: LinkKind | string | null;
  mimeType?: string | null;
  title?: string | null;
  filePath?: string | null;
  refUri?: string | null;
}): LinkDisplayCategory {
  if (args.kind === 'issue') return 'issue';
  if (args.kind === 'pr') return 'pr';
  if (args.kind === 'url') return 'url';
  if (args.kind === 'internal') return 'internal';
  if (
    args.kind === 'kb_ref' ||
    (args.refUri ? startsWithIgnoreCase(args.refUri.trim(), KB_URI_PREFIX) : false)
  )
    return 'knowledge';
  if (args.kind === 'image' || args.mimeType?.startsWith('image/')) return 'image';

  const mime = args.mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const ext = extensionFromPath(args.filePath) || extensionFromPath(args.title);

  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime === 'text/csv' || ['csv', 'tsv'].includes(ext)) return 'csv';
  if (
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    ['xls', 'xlsx', 'ods'].includes(ext)
  ) {
    return 'spreadsheet';
  }
  if (
    mime.includes('wordprocessingml') ||
    mime === 'application/msword' ||
    ['doc', 'docx', 'rtf', 'odt'].includes(ext)
  ) {
    return 'document';
  }
  if (mime === 'application/json' || ext === 'json') return 'json';
  if (ext === 'log') return 'log';
  if (['md', 'markdown'].includes(ext) || mime === 'text/markdown') return 'markdown';
  if (mime.startsWith('text/') || ['txt', 'adoc', 'rst'].includes(ext)) return 'text';
  if (CODE_EXTENSIONS.has(ext)) return 'code';

  return args.filePath ? 'document' : 'unknown';
}

export function getLinkDisplayGlyphLabel(category: LinkDisplayCategory): string {
  return GLYPH_LABELS[category];
}

export function getCompactLinkDisplayName(
  item: Pick<LinkDisplayItem, 'name' | 'category'>
): string {
  const prefixesByCategory: Partial<Record<LinkDisplayCategory, string[]>> = {
    issue: ['Issue: '],
    pr: ['PR: '],
    url: ['Link: ', 'URL: ', 'Saved URL: '],
    image: ['Image: ', 'File: '],
  };
  const prefixes =
    prefixesByCategory[item.category] ??
    (FILE_LINK_CATEGORIES.has(item.category) ? ['File: '] : []);
  for (const prefix of prefixes) {
    if (item.name.startsWith(prefix)) return item.name.slice(prefix.length);
  }
  return item.name;
}

function getPromotedFromSessionId(metadata?: Link['metadata'] | null): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const promotedFromOwner = metadata.promoted_from_owner;
  if (!promotedFromOwner || typeof promotedFromOwner !== 'object') return undefined;
  const sessionId = (promotedFromOwner as { session_id?: unknown }).session_id;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : undefined;
}

export function getLinkDisplaySecondaryLabel(
  item: Pick<LinkDisplayItem, 'url' | 'refUri' | 'filePath' | 'mimeType'>
): string | null {
  if (item.url) return urlWithoutProtocol(item.url);
  if (item.refUri) return item.refUri;
  if (!item.filePath) return null;
  if (item.mimeType) return item.mimeType;

  const filename = lastPathSegment(item.filePath);
  return filename && filename !== item.filePath ? filename : 'Uploaded file';
}

function targetKeyForLink(link: Link): string | null {
  if (link.target_key) return link.target_key;
  if (link.url) return normalizeUrlTargetKey(link.url);
  if (link.ref_uri) return normalizeRefTargetKey(link.ref_uri);
  if (link.file_path) return normalizeFileTargetKey(link.file_path);
  return null;
}

export function linkToDisplayItem(link: Link): LinkDisplayItem | null {
  const targetKey = targetKeyForLink(link);
  if (!targetKey) return null;

  const displayTarget = targetForLinkDisplay({ url: link.url, refUri: link.ref_uri });
  const promotedFromSessionId = getPromotedFromSessionId(link.metadata);
  const base = {
    key: `link:${link.link_id}`,
    targetKey,
    kind: link.kind,
    source: link.source,
    ownerScope: link.session_id ? 'session' : 'branch',
    isPinned: Boolean(link.is_pinned),
    isPromoted: isTeammatePromotionLink(link),
    linkId: String(link.link_id),
    sessionId: link.session_id ?? undefined,
    sourceSessionId: link.session_id ?? promotedFromSessionId,
    mimeType: link.mime_type ?? undefined,
    href: displayTarget?.href,
    navigation: displayTarget?.navigation,
    createdAt: link.created_at,
    updatedAt: link.updated_at,
  } satisfies Partial<LinkDisplayItem>;

  let targetData: Pick<LinkDisplayItem, 'name' | 'category' | 'url' | 'refUri' | 'filePath'>;
  if (link.url) {
    const prefix = githubKindLabel(link.kind) ?? 'Link';
    targetData = {
      name: titleOrNull(link.title) ?? `${prefix}: ${getUrlDisplayLabel(link.url)}`,
      category: getLinkDisplayCategory({ kind: link.kind, mimeType: link.mime_type }),
      url: link.url,
    };
  } else if (link.ref_uri) {
    targetData = {
      name: titleOrNull(link.title) ?? getRefDisplayLabel(link.ref_uri),
      category: getLinkDisplayCategory({
        kind: link.kind,
        mimeType: link.mime_type,
        refUri: link.ref_uri,
      }),
      refUri: link.ref_uri,
    };
  } else if (link.file_path) {
    targetData = {
      name:
        titleOrNull(link.title) ??
        `${link.kind === 'image' ? 'Image' : 'File'}: ${lastPathSegment(link.file_path)}`,
      category: getLinkDisplayCategory({
        kind: link.kind,
        mimeType: link.mime_type,
        title: link.title,
        filePath: link.file_path,
      }),
      filePath: link.file_path,
    };
  } else return null;

  return { ...base, ...targetData } as LinkDisplayItem;
}

function branchUrlToDisplayItem(args: {
  key: string;
  url: string;
  kind: Extract<LinkKind, 'issue' | 'pr'>;
}): LinkDisplayItem {
  const label = args.kind === 'issue' ? 'Issue' : 'PR';
  const safeUrl = safeWebUrl(args.url);
  return {
    key: args.key,
    name: `${label}: ${getUrlDisplayLabel(args.url)}`,
    targetKey: normalizeUrlTargetKey(args.url),
    category: args.kind,
    kind: args.kind,
    source: 'branch',
    ownerScope: 'branch',
    isPinned: false,
    url: args.url,
    href: safeUrl ?? undefined,
    navigation: safeUrl ? 'external' : undefined,
  };
}

function mergeLinkDisplayItems(items: LinkDisplayItem[]): LinkDisplayItem[] {
  const byTarget = new Map<string, LinkDisplayItem>();
  for (const item of items) {
    // targetKey is already canonicalized by the shared core helpers. Do not
    // lowercase it here: URL paths/queries and file paths can be case-sensitive.
    const key = item.targetKey;
    const existing = byTarget.get(key);
    if (
      !existing ||
      (item.isPinned && !existing.isPinned) ||
      (item.isPinned === existing.isPinned && Boolean(item.linkId) && !existing.linkId)
    ) {
      byTarget.set(key, item);
    }
  }
  return Array.from(byTarget.values());
}

function compareLinkDisplayItems(a: LinkDisplayItem, b: LinkDisplayItem): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  const nameOrder = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (nameOrder !== 0) return nameOrder;
  return a.key.localeCompare(b.key);
}

export function sortLinkDisplayItems(items: LinkDisplayItem[]): LinkDisplayItem[] {
  return [...items].sort(compareLinkDisplayItems);
}

export function buildLinkDisplayItems(args: {
  branch?: Pick<Branch, 'issue_url' | 'pull_request_url'> | null;
  links?: readonly Link[];
  includeBranchLinks?: boolean;
}): LinkDisplayItem[] {
  const items: LinkDisplayItem[] = [];
  const includeBranchLinks = args.includeBranchLinks ?? true;

  if (includeBranchLinks && args.branch?.issue_url) {
    items.push(
      branchUrlToDisplayItem({
        key: 'branch:issue',
        url: args.branch.issue_url,
        kind: 'issue',
      })
    );
  }

  if (includeBranchLinks && args.branch?.pull_request_url) {
    items.push(
      branchUrlToDisplayItem({
        key: 'branch:pr',
        url: args.branch.pull_request_url,
        kind: 'pr',
      })
    );
  }

  for (const link of args.links ?? []) {
    const item = linkToDisplayItem(link);
    if (item) items.push(item);
  }

  return sortLinkDisplayItems(mergeLinkDisplayItems(items));
}
