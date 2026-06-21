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

## Structure

```
pages/
├── index.mdx          # Landing page (symlink to README.md)
├── guide/             # User guides
│   ├── getting-started.mdx
│   ├── docker.mdx
│   └── development.mdx
├── cli/               # CLI reference (auto-generated in Phase 2)
│   └── index.mdx
└── api/               # API reference (auto-generated in Phase 2)
    └── index.mdx
```

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

## Phase 1 (Complete)

- ✅ Nextra setup with dark mode
- ✅ Agor brand colors (#2e9a92 teal)
- ✅ Landing page from README.md
- ✅ Basic navigation structure
- ✅ Guide pages (Getting Started, Docker, Development)
- ✅ Auto-generated CLI docs from oclif
- ✅ Auto-generated API docs from FeathersJS services

## Phase 2 (Next)

- [ ] Add more guide content
- [ ] Improve CLI doc parsing
- [ ] Add code examples to API docs
- [ ] Deploy to docs.agor.dev

## Generate Documentation

Auto-generate CLI and API docs:

```bash
# From root
pnpm docs:generate

# Or from docs directory
pnpm generate        # Generate both CLI and API docs
pnpm generate:cli    # Generate CLI docs only
pnpm generate:api    # Generate API docs only
```

## Build

```bash
pnpm docs:build      # Auto-generates docs then builds
```

Output: `.next/` directory

## Deployment

Docs are automatically deployed to GitHub Pages on every push to `main` that changes:

- `apps/agor-docs/**`
- `apps/agor-cli/src/commands/**` (CLI docs are auto-generated)

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
