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
