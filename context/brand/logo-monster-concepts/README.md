# Agor pixel monster logo concepts

Exploratory, non-production logo/mascot directions for Agor / agor.live.

Open `index.html` in a browser to review the panel. The marks are generated as inline SVG from small pixel-grid arrays, so the source is reproducible and easy to convert into standalone SVG/CSS pixel art later. `index.js` is the Sandpack/direct-browser entrypoint that mounts the board and draws the generated SVG monsters; `styles.css` contains the panel styling.

## Brand inputs inspected

- `apps/agor-ui/src/contexts/ThemeContext.tsx` uses `#2e9a92` as Agor teal for primary/info/link.
- `apps/agor-docs/lib/siteMetadata.ts` uses `THEME_COLOR = '#2e9a92'` and points docs logo/favicon to public assets.
- `apps/agor-docs/components/Hero.module.css` uses teal gradients: `#2e9a92`, `#7fe8df`, `#a8f5ed`.
- Existing logo files reviewed: `apps/agor-ui/public/favicon.png`, `apps/agor-docs/public/logo.png`, `.github/logo.png`, `.github/logo_circle.png`.

## Strongest directions

1. **01 Cyclops Command** — best balance of mascot memorability and favicon clarity.
2. **04 Branch Beast** — most Agor-specific because the branch-like tail/horn ties to the product's branch-centric model.
3. **07 Terminal Gremlin** — most developer-native and least childish, with command-prompt eyes.

## Notes

This does **not** replace the production logo. Next step would be selecting 2–3 candidates and redrawing them as simplified production vectors, then testing beside the lowercase docs wordmark and the in-app `Agor` mark at 16/24/32/48px.
