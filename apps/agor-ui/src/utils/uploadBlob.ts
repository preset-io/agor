import { resolveUploadServeType } from '@agor/core/types';

/**
 * Open (new tab) or download fetched upload bytes.
 *
 * A `blob:` URL inherits the Agor origin and ignores the daemon's
 * `Content-Disposition`, so an uploaded HTML/SVG file opened from a blob that
 * kept its declared type would run as Agor (stored XSS). The blob is always
 * re-typed here, and anything that is not inline-safe is downloaded instead of
 * opened, regardless of what the response claimed.
 */
export function openUploadBlob(blob: Blob, filename: string, download: boolean): void {
  const { contentType, inline } = resolveUploadServeType(blob.type);
  const url = URL.createObjectURL(new Blob([blob], { type: contentType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  if (download || !inline) anchor.download = filename;
  else anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
