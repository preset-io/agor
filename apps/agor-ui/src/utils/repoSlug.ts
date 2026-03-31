/** Extract org/repo slug from a git URL (HTTPS or SSH format) */
export function extractSlugFromUrl(url: string): string {
  try {
    const cleanUrl = url.endsWith('.git') ? url.slice(0, -4) : url;
    if (cleanUrl.includes('@')) {
      const match = cleanUrl.match(/:([^/]+\/[^/]+)$/);
      if (match) return match[1];
    }
    const match = cleanUrl.match(/[:/]([^/]+\/[^/]+)$/);
    if (match) return match[1];
    const segments = cleanUrl.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    }
    return '';
  } catch {
    return '';
  }
}

/** Create a best-effort slug from a local filesystem path (local/<dirname>) */
export function extractSlugFromPath(path: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  if (!lastSegment) return '';
  const sanitized = lastSegment
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) return '';
  return `local/${sanitized}`;
}

/** Slugify a display name into a valid worktree name */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
