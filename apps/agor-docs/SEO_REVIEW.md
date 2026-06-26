# Agor docs SEO / discoverability audit

Date: 2026-06-26  
Scope: `apps/agor-docs` source plus live `https://agor.live` inspected with Playwright and direct HTTP requests.

## Methodology

- Browser runtime: Playwright MCP visited `https://agor.live/` and `https://agor.live/guide/getting-started`, then inspected DOM head tags, headings, links, JSON-LD, images, resource timing, console messages, and network requests.
- HTTP checks: fetched `robots.txt`, `sitemap.xml`, `sitemap-0.xml`, `llms.txt`, `llms-full.txt`, representative docs URLs, a trailing-slash variant, `www.agor.live`, and a synthetic 404.
- Source checks: reviewed `apps/agor-docs/next.config.mjs`, `next-sitemap.config.cjs`, `theme.config.tsx`, `lib/siteMetadata.ts`, `public/robots.txt`, `public/llms*.txt`, page frontmatter, and landing-page image usage.
- Caveat: no full lab Lighthouse run was performed. Performance notes are based on source review, browser resource timing, and static asset sizes.

## Summary

The docs site has a strong baseline: static export, crawlable docs, unique page titles/descriptions on most pages, canonical URLs, OpenGraph/Twitter tags, JSON-LD, sitemap, robots.txt, and `llms.txt`/`llms-full.txt` for agent discoverability. The biggest opportunities are performance (large eager-loaded PNGs on the homepage), refining structured data by page type, and tightening crawler/LLM metadata hygiene.

## Changes made in this branch

Low-risk fixes implemented directly:

1. Removed `Disallow: /_next/` from `public/robots.txt` so crawlers can fetch CSS/JS required to render the static Next/Nextra pages.
2. Removed stale `https://agor.live/guide/advanced-features` links from `llms.txt` and `llms-full.txt` because that URL returns 404.
3. Added frontmatter titles/descriptions to `guide/api-proxies.mdx` and `guide/one-time-launch-auth.mdx`; these previously fell back to generated/default metadata.
4. Added `site.webmanifest` plus `<link rel="manifest">` and `<link rel="apple-touch-icon">` metadata.

## Prioritized findings

### P0 — No critical indexability blocker found

Evidence:

- `https://agor.live/robots.txt` returns 200 and allows `User-agent: *`.
- `https://agor.live/sitemap.xml` returns 200 and points to `https://agor.live/sitemap-0.xml`.
- The sitemap lists the homepage, docs, API reference, blog pages, `security`, `faq`, `llms.txt`, and `llms-full.txt`.
- `https://www.agor.live/` 301 redirects to `https://agor.live/`, establishing the canonical non-www host.
- Representative docs page `https://agor.live/guide/getting-started` returns 200 with title, description, canonical, OpenGraph/Twitter metadata, H1, and body content present in server-rendered HTML.

### P1 — Homepage eagerly loads too many large images

Evidence:

- Playwright resource timing on `https://agor.live/` showed large image bodies loaded on initial page load, including:
  - `/screenshots/board-hero.png` ~2.84 MB
  - `/logo.png` ~751 KB
  - `/images/knowledge-hero.png` ~853 KB
  - `/screenshots/conversation_full_page.png` ~685 KB
- Source: `apps/agor-docs/components/LandingPage.tsx` uses raw `<img>` for the hero, harness logos, multiplayer collage, and all product cards. The product showcase images are below the fold but do not specify `loading="lazy"`.
- `next.config.mjs` sets `output: 'export'` and `images.unoptimized: true`, so Next image optimization is not helping.

Recommendation:

- Convert screenshots used on the landing page to smaller WebP/AVIF derivatives, especially the hero/social/product preview images.
- Add `loading="lazy"` and `decoding="async"` to below-the-fold images. Keep the LCP/hero board image eager, but give it explicit dimensions or CSS aspect-ratio to reduce layout risk.
- Consider using separate thumbnail assets for product cards instead of full-size screenshots.

### P1 — Structured data is present but too generic on docs pages

Evidence:

- `theme.config.tsx` emits `SoftwareApplication` JSON-LD for every non-blog page, including deep docs pages such as `/guide/getting-started`.
- `/guide/getting-started` also emits `BreadcrumbList`, which is good.
- Blog pages switch to `BlogPosting` when `frontMatter.date` exists.

Recommendation:

- Keep `SoftwareApplication` on the homepage.
- For guide/API/security/FAQ pages, emit `TechArticle`, `Article`, `FAQPage` where appropriate, or omit page-level JSON-LD except breadcrumbs if no page-type-specific schema is available.
- Add `dateModified` only if backed by reliable file/git data; do not use build time as modified time.

### P1 — `llms.txt` had a stale 404 link; fixed here

Evidence:

- Source and live `llms.txt`/`llms-full.txt` linked `https://agor.live/guide/advanced-features`.
- Direct HTTP check returned 404.

Fix:

- Removed the stale link from both LLM metadata files.

Recommendation:

- Add a small link checker for `public/llms*.txt` and sitemap URLs to CI or the docs build.

### P1 — Robots blocked Next static assets; fixed here

Evidence:

- Live/source `robots.txt` had `Disallow: /_next/`.
- The rendered pages depend on `/_next/static/...` CSS/JS. Modern crawlers can index static HTML, but blocking render assets is discouraged because it can impair rendering, mobile friendliness, and link discovery validation.

Fix:

- Removed `Disallow: /_next/`; retained `Disallow: /404`.

### P2 — Some docs pages lacked explicit frontmatter metadata; fixed here for observed pages

Evidence:

- Source scan found `pages/guide/api-proxies.mdx` and `pages/guide/one-time-launch-auth.mdx` lacked `title` and `description` frontmatter.

Fix:

- Added concise titles/descriptions to both pages.

Recommendation:

- Keep enforcing page frontmatter. Existing `scripts/validate-social-metadata.ts` is a useful precedent; extend it to require title/description on all public MDX pages.

### P2 — Favicon/app icon coverage was minimal; improved here

Evidence:

- Live head exposed only `<link rel="icon" type="image/png" href="/favicon.png">`.
- No web app manifest or Apple touch icon was present.

Fix:

- Added `public/site.webmanifest` and head links for manifest and Apple touch icon.

Recommendation:

- Consider generating purpose-built 180x180 Apple and 192/512 PNG/PWA icons rather than reusing `favicon.png` for every context.

### P2 — Canonical/trailing slash behavior is consistent but harsh

Evidence:

- `https://agor.live/guide/getting-started` returns 200 and canonicalizes to itself.
- `https://agor.live/guide/getting-started/` returns 404, not a redirect to the slashless canonical.

Recommendation:

- This is acceptable if all internal links and sitemap URLs are slashless, which they are. If inbound links with trailing slashes are common, add host-level redirects from trailing slash to slashless paths.

### P2 — Analytics works, but privacy posture should be explicit

Evidence:

- Live pages load Google Analytics via `NEXT_PUBLIC_GA_ID`; Playwright observed `gtag/js?id=G-DME77D3LDH` and `g/collect` page-view requests.
- `gtag('config', ...)` only sets `page_path`; no explicit anonymization/consent/default-deny mode is configured in source.

Recommendation:

- Decide and document the docs-site analytics posture. If privacy-sensitive, configure consent mode defaults, avoid advertising signals, and consider `anonymize_ip`/regional settings or a privacy-preserving analytics provider.
- Add a short privacy/telemetry note if the public docs continue to load GA.

### P2 — AI crawler/training controls are intentionally permissive except ByteDance

Evidence:

- `robots.txt` allows `User-agent: *`, has a `Crawl-delay: 1`, and blocks `Bytespider`.
- No explicit rules for GPTBot, ClaudeBot, Google-Extended, CCBot, PerplexityBot, etc.
- `llms.txt` and `llms-full.txt` actively invite agent consumption.

Recommendation:

- Make an explicit product/legal choice: invite AI indexing/training, permit indexing but not training, or restrict selected bots.
- If the intent is “agent discoverability yes, model training no,” add explicit robots groups for training crawlers and document the license/usage terms in `llms.txt`.
- If the intent is broad discoverability, keep permissive robots and make `llms-full.txt` more complete/machine-readable.

### P2 — Accessibility signals are mostly sound, with a few refinements

Evidence:

- Homepage and docs pages have single clear H1s and hierarchical H2s.
- Product images generally have useful alt text where they communicate content; decorative product-card thumbnails use empty alt text, which is acceptable because surrounding card text labels the link.
- Playwright snapshot showed navbar external icons as duplicated accessible names (`GitHub GitHub`, `Discord Discord`), likely from icon + text/title duplication.
- Docs heading anchor links appear as empty links in DOM extraction; Nextra usually exposes these on hover, but empty anchor text can be noisy for assistive tech and crawlers.

Recommendation:

- Check navbar icon markup from Nextra/theme config and make duplicate icon text `aria-hidden` where possible.
- Verify heading anchor links are `aria-hidden` or have a useful label.

### P2 — Sitemap freshness currently uses build time for every page

Evidence:

- `next-sitemap.config.cjs` sets `lastmod: new Date().toISOString()` in every transform branch.
- Live sitemap showed the same build timestamp for all URLs.

Recommendation:

- Either omit `lastmod` or source it from file git history/frontmatter. Build-time `lastmod` can overstate freshness and reduce sitemap signal quality.

## Files / URLs checked

Source:

- `apps/agor-docs/next.config.mjs`
- `apps/agor-docs/next-sitemap.config.cjs`
- `apps/agor-docs/theme.config.tsx`
- `apps/agor-docs/lib/siteMetadata.ts`
- `apps/agor-docs/public/robots.txt`
- `apps/agor-docs/public/llms.txt`
- `apps/agor-docs/public/llms-full.txt`
- `apps/agor-docs/pages/**/*.mdx`
- `apps/agor-docs/components/LandingPage.tsx`

Live URLs:

- `https://agor.live/`
- `https://agor.live/guide/getting-started`
- `https://agor.live/guide/getting-started/`
- `https://agor.live/robots.txt`
- `https://agor.live/sitemap.xml`
- `https://agor.live/sitemap-0.xml`
- `https://agor.live/llms.txt`
- `https://agor.live/llms-full.txt`
- `https://www.agor.live/`
- `https://agor.live/no-such-page-seo-review`
