# Documentation Website

**Status:** Live on GitHub Pages
**Location:** `apps/agor-docs/`
**Current URL:** https://agor.live
**Deployment:** GitHub Pages via GitHub Actions (custom domain configured)

---

## Overview

Agor's documentation site is built with **Nextra**, a Next.js-based documentation framework with MDX support and built-in search.

## Tech Stack

- **Next.js 14** - React framework with static site generation
- **Nextra 3.2** - Documentation theme with built-in components
- **MDX** - Markdown with React components
- **Auto-generated CLI docs** - CLI reference generated from oclif commands

## Structure

```
apps/agor-docs/
├── pages/
│   ├── index.mdx              # Home page with overview
│   ├── faq.mdx                # FAQ with session genealogy, zones, etc.
│   │
│   ├── guide/                 # User guides
│   │   ├── getting-started.mdx
│   │   ├── concepts.mdx       # Core primitives (worktrees, boards, sessions)
│   │   ├── architecture.mdx   # System design and tech stack
│   │   ├── sdk-comparison.mdx # Claude/Codex/Gemini feature matrix
│   │   ├── docker.mdx         # Docker deployment guide
│   │   └── development.mdx    # Development setup
│   │
│   ├── cli/                   # CLI reference (auto-generated)
│   │   ├── session.mdx
│   │   ├── repo.mdx
│   │   ├── board.mdx
│   │   ├── user.mdx
│   │   └── config.mdx
│   │
│   └── api-reference/         # API documentation
│       ├── rest.mdx           # REST API endpoints
│       └── websockets.mdx     # WebSocket events
│
├── public/
│   ├── screenshots/           # Product screenshots
│   ├── logo.png               # Agor logo
│   └── favicon.png
│
├── scripts/
│   └── generate-cli-docs.ts   # Auto-generates CLI reference from oclif
│
└── theme.config.tsx           # Nextra theme configuration
```

## Key Features

- **Built-in search** - Nextra's FlexSearch integration
- **Dark mode** - Default dark theme with teal accent (#2e9a92)
- **Auto-generated CLI docs** - `pnpm generate:cli` parses oclif commands
- **Edit on GitHub links** - Direct links to source files
- **Responsive navigation** - Sidebar with collapsible sections
- **SEO-optimized** - Meta tags and Open Graph support

## Development

```bash
cd apps/agor-docs
pnpm dev        # Start dev server on :3001
pnpm build      # Generate static site
pnpm generate   # Regenerate CLI docs
```

## Current Deployment (GitHub Pages)

**Workflow:** `.github/workflows/deploy-docs.yml`

- Triggers on push to `main` (when `apps/agor-docs/**` or CLI commands change)
- Builds with base path `/agor` (set via `NEXT_PUBLIC_BASE_PATH`)
- Static export to `apps/agor-docs/out`
- Auto-deploys to https://agor.live

## TODO: Migration to agor.live

**Goal:** Move from GitHub Pages subdirectory to custom domain

**Required changes:**

1. **DNS Configuration**
   - Add CNAME record: `agor.live` → `mistercrunch.github.io`
   - Or use A records pointing to GitHub Pages IPs

2. **GitHub Pages Settings**
   - Configure custom domain in repo settings
   - Add `public/CNAME` file with `agor.live`

3. **Next.js Configuration**
   - Remove base path: `NEXT_PUBLIC_BASE_PATH` → empty/root
   - Update `next.config.mjs` to handle root deployment
   - Update asset paths in `theme.config.tsx`

4. **Deployment Options**
   - **Option A:** Keep GitHub Pages with custom domain (simplest)
   - **Option B:** Move to Vercel (better performance, auto-previews)
   - **Option C:** Cloudflare Pages (free CDN, unlimited builds)

5. **Testing**
   - Test with base path `/` locally
   - Verify all asset paths work
   - Check search functionality
   - Validate custom domain SSL

**Recommendation:** Start with GitHub Pages + custom domain (minimal changes), migrate to Vercel/Cloudflare if needed.

## Content Sources

- **User-facing content** - Written in `apps/agor-docs/pages/`
- **CLI reference** - Auto-generated from `apps/agor-cli/src/commands/`
- **Architecture docs** - Adapted from `context/concepts/` (simplified for users)

## Maintenance

- **CLI docs** - Auto-regenerated on build via `pnpm generate:cli`
- **Screenshots** - Manually updated in `public/screenshots/`
- **Architecture content** - Keep in sync with `context/concepts/` when core changes occur
