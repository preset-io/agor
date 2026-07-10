# Frontend color lint plugins

These GritQL plugins run through the existing Biome dependency and are scoped
to `agor-ui` by its nested `biome.json`.

- `noHardcodedColorLiteral` finds standalone hex and CSS-function strings in
  TypeScript/TSX, including palettes whose property names are domain-specific.
- `noHardcodedColorProperty` finds compound color strings assigned to
  color-bearing object properties, such as gradients and border shorthands.
- `noHardcodedCssColor` finds color literals in CSS declarations.

The rules intentionally avoid raw source-text matching: comments, issue
references, IDs, and hashes are not colors. Diagnostics are errors, so new
hard-coded colors fail `pnpm lint`.

`scripts/test-frontend-color-plugins.mjs` exercises positive and negative TSX
and CSS fixtures. It runs after the normal Biome check as part of `pnpm lint`.

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
