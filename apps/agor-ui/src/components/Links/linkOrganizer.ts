import {
  getCompactLinkDisplayName,
  type LinkDisplayCategory,
  type LinkDisplayItem,
} from './linkDisplay';

export type LinkCategoryTabKey = 'all' | 'files' | 'links' | 'knowledge' | 'issues';
export type LinkSortKey = 'az' | 'za' | 'recent' | 'oldest';

const KB_URI_PREFIX = 'agor://kb/';
const FILE_CATEGORIES = new Set<LinkDisplayCategory>([
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
  return Boolean(item.filePath) || FILE_CATEGORIES.has(item.category);
}

export function isKnowledgeLinkDisplayItem(item: LinkDisplayItem): boolean {
  return item.category === 'knowledge' || Boolean(item.refUri?.startsWith(KB_URI_PREFIX));
}

export function isIssuePrLinkDisplayItem(item: LinkDisplayItem): boolean {
  return item.category === 'issue' || item.category === 'pr';
}

export function isWebLinkDisplayItem(item: LinkDisplayItem): boolean {
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

export function getLinkCategorySummary(items: LinkDisplayItem[]): string {
  const counts = getLinkCategoryCounts(items);
  return [
    `${counts.files} ${counts.files === 1 ? 'file' : 'files'}`,
    `${counts.links} ${counts.links === 1 ? 'link' : 'links'}`,
    `${counts.knowledge} knowledge`,
    `${counts.issues} ${counts.issues === 1 ? 'issue/PR' : 'issues/PRs'}`,
  ].join(' · ');
}
