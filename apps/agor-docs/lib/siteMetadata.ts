const DEFAULT_SITE_URL = 'https://agor.live';

/**
 * Docs-site branding. Deliberately distinct from the in-app (agor-ui) brand,
 * which lives in apps/agor-ui/src/branding/brand.ts: the docs use a lowercase
 * "agor" wordmark and an en-dash title separator. Centralized here so
 * theme.config.tsx and the social-metadata validator share one source and the
 * favicon/logo/theme-color can't drift. Asset paths are public/-relative and
 * get the Next.js basePath applied at render time.
 */
export const BRAND_NAME = 'agor';
export const THEME_COLOR = '#2e9a92';
export const FAVICON_PATH = '/favicon.png';
export const LOGO_PATH = '/logo.svg';
// Circle-less variant (transparent background) for chrome like the navbar,
// where the full dark disc reads as a blob on dark surfaces.
export const LOGO_MARK_PATH = '/logo-mark.svg';

export const DEFAULT_TITLE = 'agor – The command center for AI enablement';

export const DEFAULT_DESCRIPTION =
  'The command center for AI enablement. Empower your team with AI teammates — Claude Code, Codex, Gemini — on a shared canvas anchored on git branches, with real-time multiplayer and an MCP surface agents drive themselves.';

export const DEFAULT_SOCIAL_IMAGE = '/screenshots/board-hero.png';

export const SOCIAL_IMAGE_FIELDS = ['ogImage', 'socialImage', 'heroImage', 'image'] as const;

export type FrontMatterLike = {
  canonical?: string;
  description?: string;
  date?: string | number | Date;
  heroImage?: string;
  image?: string;
  imageHeight?: number | string;
  imageWidth?: number | string;
  ogImage?: string;
  socialImage?: string;
  title?: string;
  [key: string]: unknown;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getSiteUrl(): string {
  return trimTrailingSlash(process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL);
}

export function getBasePath(): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

  if (!basePath) {
    return '';
  }

  return `/${basePath.replace(/^\/+|\/+$/g, '')}`;
}

export function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function withBasePath(path: string): string {
  const basePath = getBasePath();

  if (!basePath) {
    return path;
  }

  if (path === basePath || path.startsWith(`${basePath}/`)) {
    return path;
  }

  return `${basePath}${path.startsWith('/') ? path : `/${path}`}`;
}

export function toAbsoluteUrl(value: string): string {
  if (isAbsoluteUrl(value)) {
    return value;
  }

  const path = value.startsWith('/') ? value : `/${value}`;
  return `${getSiteUrl()}${withBasePath(path)}`;
}

export function getCanonicalUrl(pathname: string, canonical?: string): string {
  if (canonical) {
    return toAbsoluteUrl(canonical);
  }

  const cleanPathname = pathname === '/' ? '' : pathname;
  return toAbsoluteUrl(cleanPathname || '/');
}

export function getSocialImage(frontMatter: FrontMatterLike): string {
  const image =
    SOCIAL_IMAGE_FIELDS.map((field) => frontMatter[field]).find(Boolean) || DEFAULT_SOCIAL_IMAGE;

  return toAbsoluteUrl(String(image));
}
