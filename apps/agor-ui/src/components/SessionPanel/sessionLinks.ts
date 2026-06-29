import type { Branch, Link, LinkKind } from '@agor-live/client';
import {
  knowledgePath,
  normalizeFileTargetKey,
  normalizeRefTargetKey,
  normalizeUrlTargetKey,
} from '@agor-live/client';
import { getUrlDisplayLabel } from '../Pill/url-helpers';

export interface SessionLinkWidgetItem {
  key: string;
  name: string;
  targetKey: string;
  kind?: LinkKind;
  url?: string;
  refUri?: string;
  filePath?: string;
  href?: string;
}

const KB_URI_PREFIX = 'agor://kb/';
const KB_DOCUMENT_URI_PREFIX = 'agor://kb/document/';
const KB_UNIT_URI_PREFIX = 'agor://kb/unit/';

function cleanSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function lastPathSegment(value: string): string {
  const parts = value.split('/').filter(Boolean);
  return parts.at(-1) || value;
}

function githubKindLabel(kind?: LinkKind): 'Issue' | 'PR' | null {
  if (kind === 'issue') return 'Issue';
  if (kind === 'pr') return 'PR';
  return null;
}

export function hrefForRefUri(refUri: string): string | undefined {
  if (!refUri.startsWith(KB_URI_PREFIX)) return undefined;
  if (refUri.startsWith(KB_DOCUMENT_URI_PREFIX) || refUri.startsWith(KB_UNIT_URI_PREFIX)) {
    // No native route exists for opaque KB document/unit refs without resolving
    // them through kb/documents first. Keep the row visible but do not invent a route.
    return undefined;
  }

  const rest = refUri.slice(KB_URI_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return knowledgePath(cleanSegment(rest), null);

  const namespaceSlug = cleanSegment(rest.slice(0, slash));
  const documentPath = rest
    .slice(slash + 1)
    .split('/')
    .filter(Boolean)
    .map(cleanSegment)
    .join('/');
  return knowledgePath(namespaceSlug, documentPath || null);
}

export function getRefDisplayLabel(refUri: string): string {
  if (refUri.startsWith(KB_DOCUMENT_URI_PREFIX)) {
    return `KB document ${refUri.slice(KB_DOCUMENT_URI_PREFIX.length, KB_DOCUMENT_URI_PREFIX.length + 8)}`;
  }
  if (refUri.startsWith(KB_UNIT_URI_PREFIX)) {
    return `KB unit ${refUri.slice(KB_UNIT_URI_PREFIX.length, KB_UNIT_URI_PREFIX.length + 8)}`;
  }
  if (refUri.startsWith(KB_URI_PREFIX)) {
    return `KB: ${refUri.slice(KB_URI_PREFIX.length)}`;
  }
  return `Ref: ${refUri}`;
}

function targetKeyForLink(link: Link): string | null {
  if (link.target_key) return link.target_key;
  if (link.url) return normalizeUrlTargetKey(link.url);
  if (link.ref_uri) return normalizeRefTargetKey(link.ref_uri);
  if (link.file_path) return normalizeFileTargetKey(link.file_path);
  return null;
}

export function linkToSessionWidgetItem(link: Link): SessionLinkWidgetItem | null {
  const targetKey = targetKeyForLink(link);
  if (!targetKey) return null;

  if (link.url) {
    const prefix = githubKindLabel(link.kind);
    const name = link.title?.trim() || `${prefix ?? 'URL'}: ${getUrlDisplayLabel(link.url)}`;
    return {
      key: `link:${link.link_id}`,
      name,
      targetKey,
      kind: link.kind,
      url: link.url,
      href: link.url,
    };
  }

  if (link.ref_uri) {
    return {
      key: `link:${link.link_id}`,
      name: link.title?.trim() || getRefDisplayLabel(link.ref_uri),
      targetKey,
      kind: link.kind,
      refUri: link.ref_uri,
      href: hrefForRefUri(link.ref_uri),
    };
  }

  if (link.file_path) {
    return {
      key: `link:${link.link_id}`,
      name: link.title?.trim() || `File: ${lastPathSegment(link.file_path)}`,
      targetKey,
      kind: link.kind,
      filePath: link.file_path,
    };
  }

  return null;
}

export function buildSessionLinkWidgetItems(args: {
  branch?: Pick<Branch, 'issue_url' | 'pull_request_url'> | null;
  links?: Link[];
}): SessionLinkWidgetItem[] {
  const items: SessionLinkWidgetItem[] = [];
  const seenTargetKeys = new Set<string>();

  const addItem = (item: SessionLinkWidgetItem) => {
    const normalizedKey = item.targetKey.toLowerCase();
    if (seenTargetKeys.has(normalizedKey)) return;
    seenTargetKeys.add(normalizedKey);
    items.push(item);
  };

  if (args.branch?.issue_url) {
    const url = args.branch.issue_url;
    addItem({
      key: 'branch:issue',
      name: `Issue: ${getUrlDisplayLabel(url)}`,
      targetKey: normalizeUrlTargetKey(url),
      kind: 'issue',
      url,
      href: url,
    });
  }

  if (args.branch?.pull_request_url) {
    const url = args.branch.pull_request_url;
    addItem({
      key: 'branch:pr',
      name: `PR: ${getUrlDisplayLabel(url)}`,
      targetKey: normalizeUrlTargetKey(url),
      kind: 'pr',
      url,
      href: url,
    });
  }

  for (const link of args.links ?? []) {
    const item = linkToSessionWidgetItem(link);
    if (item) addItem(item);
  }

  return items;
}
