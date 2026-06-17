/**
 * Single source of truth for agor-ui's surface branding: the Agor mark asset
 * (used as both favicon and in-chrome logo) and the document-title format.
 *
 * Every web surface in this app (Workspace, Knowledge, Artifact fullscreen, …)
 * consumes these helpers so favicon/title metadata can't drift as new surfaces
 * are added. See surfaceRegistry.ts for the per-surface branding declarations
 * and brand.test.ts / surfaceRegistry.test.ts for the regression guards.
 *
 * The docs site (apps/agor-docs) is a standalone Next.js package with
 * deliberately distinct branding (lowercase "agor" wordmark, en-dash title
 * separator, social-card metadata). It centralizes its own constants in
 * apps/agor-docs/lib/siteMetadata.ts and cannot import this module.
 */

export const BRAND = {
  /** Wordmark used in document titles and image alt text. */
  name: 'Agor',
  /** Agor mark asset, served from the Vite public dir (favicon + logo). */
  markFile: 'favicon.png',
  /** Separator between a surface label and the brand name in tab titles. */
  titleSeparator: ' · ',
} as const;

/**
 * Absolute, base-aware URL to the Agor mark asset (favicon / logo).
 *
 * MUST be absolute (base-prefixed), never a bare relative `favicon.png`: SPA
 * surfaces live at nested paths (e.g. `/ui/knowledge/<ns>/<doc>`) and a
 * relative href resolves against the current document URL → 404. This is the
 * bug that made the Knowledge surface's favicon disappear on deep links.
 */
export function brandMarkHref(baseUrl: string = import.meta.env.BASE_URL): string {
  return `${baseUrl}${BRAND.markFile}`;
}

/** Build a document title for a surface, e.g. `surfaceTitle('Knowledge')` → "Knowledge · Agor". */
export function surfaceTitle(label?: string | null): string {
  return label ? `${label}${BRAND.titleSeparator}${BRAND.name}` : BRAND.name;
}
