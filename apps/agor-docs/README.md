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

Alternative options: Cloudflare Pages or Vercel (see [context/explorations/docs-website.md](../../context/explorations/docs-website.md))
