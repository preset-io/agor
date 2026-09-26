# Agor Documentation

Documentation website built with Nextra.

## Development

```bash
# From project root
pnpm docs:dev

# Or directly
cd apps/agor-docs
pnpm dev
```

Open http://localhost:3001

## Site analytics

The public docs deployment sets `NEXT_PUBLIC_GA_ID=G-DME77D3LDH`. A measurement ID is
public configuration, not a credential. The integration is omitted when the variable is
unset and is otherwise enabled for production builds. To exercise it in `pnpm dev`, also
set `NEXT_PUBLIC_ANALYTICS_DEBUG=true`; use a test property or block collection requests.

Google Analytics sends one explicit `page_view` for the initial URL and each client-side
App Router navigation. Its automatic page view is disabled to prevent duplicates. The
site currently has no cookie-consent gate and does not interpret the browser's legacy Do
Not Track signal; this matches the existing site-wide Microsoft Clarity and HubSpot
loaders. Visitors can block these third-party scripts with browser privacy controls.

The GitHub Pages deployment does not currently send a Content Security Policy. If one is
added, it must allow the GA loader from `https://www.googletagmanager.com` and collection
to `https://www.google-analytics.com` (plus the existing Clarity and HubSpot origins).

## Brand assets

`public/logo-mark.svg` is the transparent Agor mark for normal web and
in-product rendering. `public/logo.svg` contains the same artwork on a fixed
dark circular plate for favicons and other small contexts where the mark needs
a predictable backdrop. Both have explicit `734 × 734` intrinsic dimensions
and the same square viewBox.

The standalone Vite app keeps byte-identical deployment copies of both SVGs in
`../agor-ui/public/`; `pnpm validate:brand-assets` guards the copies and the
transparent/backed distinction against drift. Do not add PNG logo/favicon
copies for ordinary browser rendering.

`public/apple-touch-icon.png` is the only compatibility raster. Apple touch
icons require PNG output, so regenerate its transparent `180 × 180` render from
the canonical SVG with:

```bash
apps/agor-docs/scripts/generate-apple-touch-icon.sh
```

Screenshots, social-card images, generated video frames, and third-party tool
logos are content assets rather than alternate Agor marks and keep the format
required by their destination.

## Structure

```text
content/              # Published MDX, including unlisted pages
├── guide/            # Getting started, using, operating, developing/reference
├── blog/             # Historical posts and case studies
└── api-reference/    # Public API documentation
app/                  # App Router routes and static page enumeration
lib/docsNavigation.ts # Shared guide navigation, imported by guide/_meta.ts
public/               # Static assets, OpenAPI schema, and LLM documentation indexes
```

The catch-all route recursively publishes MDX from `content/`; hiding a page in
navigation does not unpublish it. The homepage has its own route.

Organize guide navigation by reader task: **Getting started**, **Using Agor**,
**Operating Agor**, and **Developing & Reference**. Keep everyday workflow and
permission guidance accessible to users; put deployment configuration, migrations,
and administrative recovery under Operating Agor. Contributor internals belong
in development/reference, not feature introductions. Prefer stable URLs and
leave a linked compatibility heading or anchor when moving an existing section.
Update `public/llms.txt` and `public/llms-full.txt` when adding reader entry points.

## Page metadata and social previews

All page-level social metadata is centralized in `theme.config.tsx`. Authors should set
frontmatter instead of adding ad hoc `<Head>` tags:

```mdx
---
title: Cards
description: Generic workflow cards that give you spatial oversight of any agentic workflow.
heroImage: '/screenshots/cards-hero.png'
---
```

- `image` is the existing blog-post hero/card image convention.
- `heroImage` is the docs/feature-page convention for pages with a visible hero screenshot.
- `socialImage` or `ogImage` may be used only when the social preview should intentionally
  differ from the visible hero image.

Local image paths must live under `public/` and start with `/`. The metadata layer turns
them into absolute `og:image` and `twitter:image` URLs using `NEXT_PUBLIC_SITE_URL` plus
`NEXT_PUBLIC_BASE_PATH` when configured. Pages without any image field fall back to
`/screenshots/board-hero.png`. Add `imageWidth` and `imageHeight` only when you know the exact image
dimensions.

## Validate and build

From the repository root:

```bash
pnpm --filter @agor/docs typecheck
pnpm --filter @agor/docs validate:brand-assets
pnpm --filter @agor/docs validate:social-metadata
pnpm docs:build
```

The build compiles MDX, exports the site to `apps/agor-docs/out/`, and generates
sitemap and Pagefind search assets. It does not regenerate API or CLI documentation.
The legacy root `docs:generate` alias has no matching docs-package script.

For an analytics export check, set a test `NEXT_PUBLIC_GA_ID` during both the build
and `pnpm --filter @agor/docs validate:analytics`. Do not send test traffic to the
production analytics property. Check internal links and fragments in the exported
HTML, especially when moving headings or changing navigation.

## Deployment

Docs are automatically deployed to GitHub Pages on every push to `main` that changes:

- `apps/agor-docs/**`
- `apps/agor-cli/src/commands/**` (also triggers the workflow)

**GitHub Pages Setup (one-time):**

1. Go to repository Settings → Pages
2. Source: **GitHub Actions**
3. That's it! The workflow (`.github/workflows/deploy-docs.yml`) handles the rest.

**Manual deployment trigger:**

```bash
gh workflow run deploy-docs.yml
```

**Deployment URL:** https://agor.live/

Alternative deployment targets (Cloudflare Pages, Vercel) work as well — Nextra static export is portable.
