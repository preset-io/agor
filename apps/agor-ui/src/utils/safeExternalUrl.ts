const SAFE_EXTERNAL_PROTOCOLS = ['http:', 'https:', 'mailto:'];

/** Whether a user-supplied URL is safe to render as a link (blocks `javascript:` and friends). */
export function isSafeExternalUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return SAFE_EXTERNAL_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
