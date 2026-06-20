# Agor imagegen monster logo concepts

Exploratory, non-production mascot/logo directions for Agor / agor.live.

Open `index.html` in a browser, or view the published Agor artifact. This pass uses file-backed raster concept sheets generated via the OpenAI Images API, plus a polished static review gallery.

## Generated sheets

- `generated/wide-board-monster-variants.png` — focused landscape board-card monster candidates. Current lead direction; strongest first-pass picks: **A, C, E, G**.
- `generated/refined-logo-monsters.png` — friendlier, mascot-forward logo candidates. Useful reference for an app-icon crop.
- `generated/edgy-logo-monsters.png` — more distinctive tech/product brand-mark candidates. Useful attitude references, less directly tied to Agor.

## Brand inputs inspected

- `apps/agor-ui/src/contexts/ThemeContext.tsx` uses `#2e9a92` as Agor teal for primary/info/link.
- `apps/agor-docs/lib/siteMetadata.ts` uses `THEME_COLOR = '#2e9a92'` and points docs logo/favicon to public assets.
- `apps/agor-docs/components/Hero.module.css` uses teal gradients: `#2e9a92`, `#7fe8df`, `#a8f5ed`.
- Existing logo files reviewed: `apps/agor-ui/public/favicon.png`, `apps/agor-docs/public/logo.png`, `.github/logo.png`, `.github/logo_circle.png`.

## Next step

Vectorize one wide board-monster direction first, then stress-test it at website-logo, branch-card avatar, app-icon, favicon, and monochrome sizes beside the Agor wordmark.
