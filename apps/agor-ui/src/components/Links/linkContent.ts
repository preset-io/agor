import { getDaemonUrl } from '../../config/daemon';
import { getAgorAccessToken } from '../../utils/authHeaders';
import type { LinkDisplayCategory, LinkDisplayItem } from './linkDisplay';

export interface LinkContentTarget {
  linkId: string;
  title: string;
  subtitle?: string | null;
}

type LinkContentDisposition = 'inline' | 'attachment';
type LinkContentAction = 'preview' | 'download';
export type LinkPreviewKind = 'image' | 'markdown' | 'text';
export type LinkContentItem = Pick<
  LinkDisplayItem,
  'category' | 'filePath' | 'href' | 'kind' | 'linkId' | 'mimeType' | 'source'
>;

const INLINE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const INLINE_IMAGE_ACCEPT = [...INLINE_IMAGE_MIME_TYPES].join(', ');

const PREVIEW_CATEGORIES: Partial<Record<LinkDisplayCategory, LinkPreviewKind>> = {
  image: 'image',
  markdown: 'markdown',
  text: 'text',
};

function getLinkContentPath(
  linkId: string,
  disposition: LinkContentDisposition = 'attachment'
): string {
  const encodedId = encodeURIComponent(linkId);
  return `/link-content/${encodedId}?disposition=${disposition}`;
}

function getLinkContentUrl(
  linkId: string,
  disposition: LinkContentDisposition = 'attachment',
  daemonUrl = getDaemonUrl()
): string {
  return `${daemonUrl.replace(/\/$/, '')}${getLinkContentPath(linkId, disposition)}`;
}

export function getLinkPreviewKind(item: LinkContentItem): LinkPreviewKind | null {
  if (item.source !== 'upload' || !item.linkId || !item.filePath) return null;
  const mimeType = item.mimeType?.split(';')[0]?.trim().toLowerCase();
  if (mimeType) {
    if (item.category === 'image' && !INLINE_IMAGE_MIME_TYPES.has(mimeType)) return null;
    if (item.category === 'markdown' && mimeType !== 'text/markdown') return null;
    if (item.category === 'text' && mimeType !== 'text/plain') return null;
  }
  return PREVIEW_CATEGORIES[item.category] ?? null;
}

export function getLinkContentAction(item: LinkContentItem): LinkContentAction | null {
  if (getLinkPreviewKind(item)) return 'preview';
  if (item.source === 'upload' && item.linkId && item.filePath) {
    return 'download';
  }
  return null;
}

export function getLinkUnavailableReason(item: LinkContentItem): string | null {
  if (getLinkContentAction(item) || item.href) return null;
  if (item.source === 'upload' || item.filePath || item.kind === 'image') {
    return 'Preview/download unavailable';
  }
  return 'No safe route is available for this item yet.';
}

function isLocalFilePathLike(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.includes('\\')
  );
}

function basenameFromPathLike(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  const parts = withoutQuery.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || value;
}

export function getSafeLinkContentLabel(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('agor://')) return trimmed;
  try {
    // Preserve URLs; callers already decide whether a URL is safe to open.
    // This helper only avoids surfacing daemon-local filesystem paths.
    new URL(trimmed);
    return trimmed;
  } catch {
    // Not a fully-qualified URL.
  }
  return isLocalFilePathLike(trimmed) ? basenameFromPathLike(trimmed) : trimmed;
}

async function fetchLinkContent(
  linkId: string,
  options?: {
    disposition?: LinkContentDisposition;
    download?: boolean;
    accept?: string;
    signal?: AbortSignal;
  }
): Promise<Response> {
  const token = getAgorAccessToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options?.accept) headers.Accept = options.accept;

  const disposition = options?.download ? 'attachment' : (options?.disposition ?? 'inline');
  const response = await fetch(getLinkContentUrl(linkId, disposition), {
    headers,
    signal: options?.signal,
  });
  if (!response.ok) {
    let message = `Link content request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  return response;
}

async function fetchLinkObjectUrl(
  linkId: string,
  options?: {
    download?: boolean;
    accept?: string;
    signal?: AbortSignal;
    allowedMimeTypes?: ReadonlySet<string>;
  }
): Promise<string> {
  const response = await fetchLinkContent(linkId, options);
  const responseMimeType = response.headers
    .get('Content-Type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (
    options?.allowedMimeTypes &&
    (!responseMimeType || !options.allowedMimeTypes.has(responseMimeType))
  ) {
    await response.body?.cancel();
    throw new Error('Preview returned an unsupported image type');
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export function fetchLinkImageObjectUrl(linkId: string, signal?: AbortSignal): Promise<string> {
  return fetchLinkObjectUrl(linkId, {
    accept: INLINE_IMAGE_ACCEPT,
    allowedMimeTypes: INLINE_IMAGE_MIME_TYPES,
    signal,
  });
}

export async function fetchLinkMarkdownText(linkId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchLinkContent(linkId, {
    disposition: 'inline',
    accept: 'text/markdown, text/plain;q=0.9',
    signal,
  });
  return response.text();
}

function fallbackDownloadFilename(title: string): string {
  return title.replace(/[\r\n"\\/:*?<>|]/g, '_').slice(0, 180) || 'download';
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return value.match(/filename="([^"]+)"/i)?.[1] ?? null;
}

export async function downloadLinkContent(linkId: string, title: string): Promise<void> {
  const response = await fetchLinkContent(linkId, {
    download: true,
    accept: 'application/octet-stream',
  });
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download =
    filenameFromContentDisposition(response.headers.get('Content-Disposition')) ??
    fallbackDownloadFilename(title);
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
