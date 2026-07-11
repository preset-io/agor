import {
  FILE_LINK_CATEGORIES,
  getCompactLinkDisplayName,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
} from './linkDisplay';

export type LinkCategoryTabKey = 'all' | 'files' | 'links' | 'knowledge' | 'issues';
export type LinkSortKey = 'az' | 'za' | 'recent' | 'oldest';

const KB_URI_PREFIX = 'agor://kb/';
export const LINK_CATEGORY_TAB_LABELS: Record<LinkCategoryTabKey, string> = {
  all: 'All',
  files: 'Files',
  links: 'Links',
  knowledge: 'Knowledge',
  issues: 'Issues/PRs',
};

export const LINK_SORT_LABELS: Record<LinkSortKey, string> = {
  az: 'A-Z',
  za: 'Z-A',
  recent: 'Recent',
  oldest: 'Old to new',
};

export function isFileLinkDisplayItem(item: LinkDisplayItem): boolean {
  return Boolean(item.filePath) || FILE_LINK_CATEGORIES.has(item.category);
}

export function isKnowledgeLinkDisplayItem(item: LinkDisplayItem): boolean {
  return item.category === 'knowledge' || Boolean(item.refUri?.startsWith(KB_URI_PREFIX));
}

function isIssuePrLinkDisplayItem(item: LinkDisplayItem): boolean {
  return item.category === 'issue' || item.category === 'pr';
}

function isWebLinkDisplayItem(item: LinkDisplayItem): boolean {
  return (
    !isFileLinkDisplayItem(item) &&
    !isKnowledgeLinkDisplayItem(item) &&
    !isIssuePrLinkDisplayItem(item)
  );
}

export function matchesLinkCategoryTab(
  item: LinkDisplayItem,
  category: LinkCategoryTabKey
): boolean {
  switch (category) {
    case 'files':
      return isFileLinkDisplayItem(item);
    case 'links':
      return isWebLinkDisplayItem(item);
    case 'knowledge':
      return isKnowledgeLinkDisplayItem(item);
    case 'issues':
      return isIssuePrLinkDisplayItem(item);
    default:
      return true;
  }
}

function compareLinkNames(a: LinkDisplayItem, b: LinkDisplayItem): number {
  const nameOrder = getCompactLinkDisplayName(a).localeCompare(
    getCompactLinkDisplayName(b),
    undefined,
    { sensitivity: 'base' }
  );
  return nameOrder || a.key.localeCompare(b.key);
}

export function compareLinkDisplayItemsBySort(
  a: LinkDisplayItem,
  b: LinkDisplayItem,
  sort: LinkSortKey
): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  if (sort === 'za') return -compareLinkNames(a, b);
  if (sort === 'recent' || sort === 'oldest') {
    const timestampOrder = (a.updatedAt || a.createdAt || '').localeCompare(
      b.updatedAt || b.createdAt || ''
    );
    if (timestampOrder !== 0) return sort === 'recent' ? -timestampOrder : timestampOrder;
  }
  return compareLinkNames(a, b);
}

export function getLinkCategoryCounts(
  items: LinkDisplayItem[]
): Record<LinkCategoryTabKey, number> {
  return {
    all: items.length,
    files: items.filter(isFileLinkDisplayItem).length,
    links: items.filter(isWebLinkDisplayItem).length,
    knowledge: items.filter(isKnowledgeLinkDisplayItem).length,
    issues: items.filter(isIssuePrLinkDisplayItem).length,
  };
}

export function selectQuickLinkDisplayItems(
  items: readonly LinkDisplayItem[],
  limit = 7
): LinkDisplayItem[] {
  if (limit <= 0) return [];

  const selected = selectPinnedLinkDisplayItems(items).slice(0, Math.min(3, limit));
  const selectedKeys = new Set(selected.map((item) => item.key));
  const files = items.filter(isFileLinkDisplayItem);
  const selectedFileCount = selected.filter(isFileLinkDisplayItem).length;
  const reservedFileSlots = Math.max(0, Math.min(2, files.length) - selectedFileCount);
  const recentLimit = Math.max(0, limit - selected.length - reservedFileSlots);

  selected.push(
    ...items.filter((item) => !item.isPinned && !isFileLinkDisplayItem(item)).slice(0, recentLimit)
  );
  for (const file of files) {
    if (selected.length >= limit) break;
    if (!selectedKeys.has(file.key)) selected.push(file);
  }
  return selected;
}

export function selectPinnedLinkDisplayItems(items: readonly LinkDisplayItem[]): LinkDisplayItem[] {
  return items.filter((item) => item.isPinned);
}

export function matchesLinkDisplaySearch(
  item: LinkDisplayItem,
  query: string,
  extraFields: Array<string | null | undefined> = []
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const fields = [
    item.name,
    getCompactLinkDisplayName(item),
    getLinkDisplaySecondaryLabel(item),
    item.url,
    item.refUri,
    item.filePath,
    ...extraFields,
  ];
  return fields.some((field) => field?.toLowerCase().includes(normalizedQuery));
}
