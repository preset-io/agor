import type { LinkDisplayItem } from '../Links';
import {
  compareLinkDisplayItemsBySort,
  getLinkCategoryCounts,
  isFileLinkDisplayItem,
  type LinkCategoryTabKey,
  type LinkSortKey,
  matchesLinkCategoryTab,
  matchesLinkDisplaySearch,
} from '../Links';
import { type LinkAttachmentTarget, targetForLinkAttachment } from '../Links/LinkAttachmentCard';
import {
  getLinkContentAction,
  getLinkPreviewKind,
  getSafeLinkContentLabel,
} from '../Links/linkContent';

export type SessionAttachmentItem = LinkDisplayItem & {
  subtitle?: string;
  disabled?: boolean;
  note?: string;
  originSessionLabel?: string;
};

export function displayItemToSessionAttachmentItem(item: LinkDisplayItem): SessionAttachmentItem {
  const unsupportedUpload =
    Boolean(item.filePath) && !item.href && !getLinkContentAction(item) && item.source === 'upload';
  return {
    ...item,
    disabled: unsupportedUpload,
    note: unsupportedUpload ? 'Preview/download unavailable' : undefined,
    originSessionLabel: item.sourceSessionId?.slice(0, 8),
  };
}

export function targetForSessionAttachment(
  item: SessionAttachmentItem
): LinkAttachmentTarget | null {
  return targetForLinkAttachment({ url: item.url, refUri: item.refUri });
}

export function canPreviewSessionImage(item: SessionAttachmentItem): boolean {
  return getLinkPreviewKind(item) === 'image' && !item.disabled;
}

export function canPreviewSessionMarkdown(item: SessionAttachmentItem): boolean {
  const previewKind = getLinkPreviewKind(item);
  return !item.disabled && (previewKind === 'markdown' || previewKind === 'text');
}

export function canDownloadSessionFile(item: SessionAttachmentItem): boolean {
  return !item.disabled && getLinkContentAction(item) === 'download';
}

export function sessionAttachmentDisabledReason(item: SessionAttachmentItem): string | null {
  if (item.disabled) return item.note || 'Preview/download unavailable';
  if (
    canPreviewSessionImage(item) ||
    canPreviewSessionMarkdown(item) ||
    canDownloadSessionFile(item)
  ) {
    return null;
  }
  if (item.source === 'upload' || isFileLinkDisplayItem(item)) {
    return item.note || 'Preview/download unavailable';
  }
  if (!targetForSessionAttachment(item)) return 'No safe route is available for this item yet.';
  return null;
}

export function getSessionAttachmentTargetDisplay(item: SessionAttachmentItem): string {
  if (item.subtitle) return item.subtitle;
  if (item.url) {
    try {
      const parsed = new URL(item.url);
      return `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return item.url;
    }
  }
  if (item.refUri) return item.refUri;
  if (item.filePath) return getSafeLinkContentLabel(item.filePath) || 'Uploaded file';
  return 'No target';
}

export function getSessionAttachmentCategoryCounts(items: SessionAttachmentItem[]) {
  return getLinkCategoryCounts(items);
}

export function matchesSessionAttachmentCategory(
  item: SessionAttachmentItem,
  category: LinkCategoryTabKey
): boolean {
  return matchesLinkCategoryTab(item, category);
}

export function compareSessionAttachments(
  a: SessionAttachmentItem,
  b: SessionAttachmentItem,
  sort: LinkSortKey
): number {
  return compareLinkDisplayItemsBySort(a, b, sort);
}

export function matchesSessionAttachmentSearch(
  item: SessionAttachmentItem,
  query: string
): boolean {
  return matchesLinkDisplaySearch(item, query, [
    item.subtitle,
    getSessionAttachmentTargetDisplay(item),
    item.filePath ? getSafeLinkContentLabel(item.filePath) : null,
    item.originSessionLabel,
  ]);
}
