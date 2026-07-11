# Frontend design-system lint plugins

These GritQL plugins run through the existing Biome dependency and are scoped
to `agor-ui` by its nested `biome.json`.

- `noHardcodedColorLiteral` finds unambiguous hex and modern CSS-color syntax anywhere
  in TypeScript/TSX strings, including conditions, templates, gradients, `color-mix()`,
  shadows, and generated HTML/CSS, without treating prose issue references as colors.
- `noHardcodedColorProperty` catches ambiguous hex and the complete CSS named-color set in
  compound values beneath color-bearing style properties, while allowing SVG fragment URLs.
- `noHardcodedColorAttribute` covers three-digit hex in JSX color attributes
  while preserving AntD preset props such as `<Tag color="blue">`.
- `noHardcodedCssColor` finds hex, functional (including `hwb()`, `lab()`, and `lch()`),
  named, and percent-encoded data-SVG colors in CSS declarations without treating asset URLs
  or `url(#fragment)` as colors.
- `noDirectAntCssVar` requires React code to use typed `theme.useToken()` values;
  non-React CSS-string boundaries need a documented exception.
- `noFirstPartyCss` denies first-party CSS by default. Files that genuinely need
  selectors, keyframes, semantic-content rules, or third-party integration use
  a reasoned whole-file suppression.

The rules use Biome's parsed syntax rather than broad filesystem grep: comments,
issue references, IDs, and hashes are not colors. Diagnostics are errors, so
new violations fail `pnpm lint`.

`scripts/test-frontend-color-plugins.mjs` exercises individually named positive and negative TSX
and CSS cases, including issue prose, asset URLs, spaced/quoted SVG fragments, compound named
colors, named shadows, custom properties whose identifiers contain color names, `color-mix()`,
quoted encoded data-SVG colors, conditional values, and suppression behavior. It exercises every
canonical CSS named color in both languages to keep the rules' name sets aligned. Fixtures use
unique temporary names so concurrent lint runs cannot collide. The test runs after the normal
Biome check as part of `pnpm lint`.

Prefer fixing a finding with the right vanilla AntD component. If a legitimate
exact-color domain needs an exception, use the narrowest applicable suppression
with a concrete reason:

```tsx
// biome-ignore lint/plugin/noHardcodedColorLiteral: exact partner logo color
const partnerColor = '#123456';
```

Whole-file `biome-ignore-all` suppressions are appropriate only when exact
colors are the file's purpose, such as a terminal palette or theme seed. Avoid
suppressing an entire component directory.

Approved first-party CSS starts with a separate explanation:

```css
/* biome-ignore-all lint/plugin/noFirstPartyCss: rendered document headings require descendant and hover selectors */
```
