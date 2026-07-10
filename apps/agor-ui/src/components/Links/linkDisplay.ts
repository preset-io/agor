import type { Branch, Link, LinkKind, LinkSource } from '@agor-live/client';
import {
  normalizeFileTargetKey,
  normalizeRefTargetKey,
  normalizeUrlTargetKey,
} from '@agor-live/client';
import { buildKnowledgeRoutePath } from '../../utils/knowledgeRoutes';
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
export type LinkDisplaySource = LinkSource | 'branch';

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

function cleanSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeWebUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
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
  if (!refUri?.startsWith(KB_URI_PREFIX)) return null;
  if (refUri.startsWith(KB_DOCUMENT_URI_PREFIX) || refUri.startsWith(KB_UNIT_URI_PREFIX)) {
    return null;
  }

  const rest = refUri.slice(KB_URI_PREFIX.length);
  const [namespaceSlug, ...pathParts] = rest.split('/').filter(Boolean).map(cleanSegment);
  if (!namespaceSlug || namespaceSlug === 'document' || namespaceSlug === 'unit') return null;

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

export function getRefDisplayLabel(refUri: string): string {
  if (refUri.startsWith(KB_DOCUMENT_URI_PREFIX)) {
    return `KB document ${refUri.slice(KB_DOCUMENT_URI_PREFIX.length, KB_DOCUMENT_URI_PREFIX.length + 8)}`;
  }
  if (refUri.startsWith(KB_UNIT_URI_PREFIX)) {
    return `KB unit ${refUri.slice(KB_UNIT_URI_PREFIX.length, KB_UNIT_URI_PREFIX.length + 8)}`;
  }
  if (refUri.startsWith(KB_URI_PREFIX)) return `KB: ${refUri.slice(KB_URI_PREFIX.length)}`;
  return `Ref: ${refUri}`;
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
  if (args.kind === 'kb_ref' || args.refUri?.startsWith(KB_URI_PREFIX)) return 'knowledge';
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
  if (
    [
      'js',
      'jsx',
      'ts',
      'tsx',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'c',
      'cc',
      'cpp',
      'h',
      'hpp',
      'css',
      'scss',
      'html',
      'xml',
      'yaml',
      'yml',
      'toml',
      'sql',
      'sh',
      'zsh',
    ].includes(ext)
  ) {
    return 'code';
  }

  return args.filePath ? 'document' : 'unknown';
}

export function getLinkDisplayGlyphLabel(category: LinkDisplayCategory): string {
  switch (category) {
    case 'knowledge':
      return 'KB';
    case 'image':
      return 'IMG';
    case 'pdf':
      return 'PDF';
    case 'spreadsheet':
      return 'XLS';
    case 'csv':
      return 'CSV';
    case 'document':
      return 'DOC';
    case 'markdown':
      return 'MD';
    case 'text':
      return 'TXT';
    case 'code':
      return 'CODE';
    case 'json':
      return 'JSON';
    case 'log':
      return 'LOG';
    case 'issue':
      return 'ISSUE';
    case 'pr':
      return 'PR';
    case 'url':
      return 'URL';
    case 'internal':
      return 'REF';
    default:
      return 'LINK';
  }
}

export function getLinkDisplayPillLabel(category: LinkDisplayCategory): string {
  switch (category) {
    case 'knowledge':
      return 'Knowledge';
    case 'image':
      return 'Image';
    case 'pdf':
      return 'PDF';
    case 'spreadsheet':
      return 'XLS';
    case 'csv':
      return 'CSV';
    case 'document':
      return 'Doc';
    case 'markdown':
      return 'MD';
    case 'text':
      return 'Text';
    case 'code':
      return 'Code';
    case 'json':
      return 'JSON';
    case 'log':
      return 'Log';
    case 'issue':
      return 'Issue';
    case 'pr':
      return 'PR';
    case 'url':
      return 'Link';
    case 'internal':
      return 'Ref';
    default:
      return 'Link';
  }
}

export function getCompactLinkDisplayName(
  item: Pick<LinkDisplayItem, 'name' | 'category'>
): string {
  const prefixesByCategory: Partial<Record<LinkDisplayCategory, string[]>> = {
    issue: ['Issue: '],
    pr: ['PR: '],
    url: ['Link: ', 'URL: ', 'Saved URL: '],
    image: ['Image: ', 'File: '],
    pdf: ['File: '],
    spreadsheet: ['File: '],
    csv: ['File: '],
    document: ['File: '],
    markdown: ['File: '],
    text: ['File: '],
    code: ['File: '],
    json: ['File: '],
    log: ['File: '],
  };
  for (const prefix of prefixesByCategory[item.category] ?? []) {
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

export function targetKeyForLink(link: Link): string | null {
  if (link.target_key) return link.target_key;
  if (link.url) return normalizeUrlTargetKey(link.url);
  if (link.ref_uri) return normalizeRefTargetKey(link.ref_uri);
  if (link.file_path) return normalizeFileTargetKey(link.file_path);
  return null;
}

export function linkToDisplayItem(link: Link): LinkDisplayItem | null {
  const targetKey = targetKeyForLink(link);
  if (!targetKey) return null;

  const target = targetForLinkDisplay({ url: link.url, refUri: link.ref_uri });
  const base = {
    key: `link:${link.link_id}`,
    targetKey,
    kind: link.kind,
    source: link.source,
    ownerScope: link.session_id ? 'session' : 'branch',
    isPinned: Boolean(link.is_pinned),
    isPromoted: Boolean(getPromotedFromSessionId(link.metadata)),
    linkId: String(link.link_id),
    sessionId: link.session_id ?? undefined,
    sourceSessionId: link.session_id ?? getPromotedFromSessionId(link.metadata),
    mimeType: link.mime_type ?? undefined,
    href: target?.href,
    navigation: target?.navigation,
    createdAt: link.created_at,
    updatedAt: link.updated_at,
  } satisfies Partial<LinkDisplayItem>;

  if (link.url) {
    const prefix = githubKindLabel(link.kind) ?? 'Link';
    return {
      ...base,
      name: titleOrNull(link.title) ?? `${prefix}: ${getUrlDisplayLabel(link.url)}`,
      category: getLinkDisplayCategory({ kind: link.kind, mimeType: link.mime_type }),
      url: link.url,
    } as LinkDisplayItem;
  }

  if (link.ref_uri) {
    return {
      ...base,
      name: titleOrNull(link.title) ?? getRefDisplayLabel(link.ref_uri),
      category: getLinkDisplayCategory({
        kind: link.kind,
        mimeType: link.mime_type,
        refUri: link.ref_uri,
      }),
      refUri: link.ref_uri,
    } as LinkDisplayItem;
  }

  if (link.file_path) {
    const fallbackPrefix = link.kind === 'image' ? 'Image' : 'File';
    return {
      ...base,
      name: titleOrNull(link.title) ?? `${fallbackPrefix}: ${lastPathSegment(link.file_path)}`,
      category: getLinkDisplayCategory({
        kind: link.kind,
        mimeType: link.mime_type,
        title: link.title,
        filePath: link.file_path,
      }),
      filePath: link.file_path,
    } as LinkDisplayItem;
  }

  return null;
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

export function mergeLinkDisplayItems(items: LinkDisplayItem[]): LinkDisplayItem[] {
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

export function compareLinkDisplayItems(a: LinkDisplayItem, b: LinkDisplayItem): number {
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
