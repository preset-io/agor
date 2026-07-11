# Frontend design-system guidelines

Use **Ant Design (AntD) as Agor's default UI and design system**. Start with the
[component library](https://ant.design/components/overview/) and
[theme tokens](https://ant.design/docs/react/customize-theme/), then inspect nearby Agor code.

## Start with the component, not the styling

- Use vanilla AntD whenever possible: `Button`, `Input`, `Select`, `Modal`, `Table`, `List`,
  `Card`, `Dropdown`, `Tooltip`, `Typography`, `Flex`, `Space`, `Tabs`, `Segmented`, and the
  corresponding feedback/status components. Compose their public APIs before adding styling.
- Choose the right base component. Do not recreate a `Card` with a `div` plus hand-selected
  background, border, text, and hover tokens. Correct AntD component choice should provide most
  visuals, states, semantics, and accessibility without decomposition.
- Search `apps/agor-ui/src/components/` before adding a component. Reuse an Agor composite when
  one already owns the behavior. A one-off may remain local and light; when a bespoke interaction
  appears a second time, consolidate every occurrence into a small AntD-backed shared component.
- Limit invention. A proposed new primitive should be designed with the restraint and API quality
  expected from AntD itself. First verify that it is not an existing AntD component in disguise.

## Styling hierarchy

Use this order, stopping as early as possible:

1. Vanilla AntD component with its normal appearance.
2. AntD component composition and public props.
3. Existing Agor shared component.
4. AntD's semantic `styles`/`classNames` API when a component exposes it.
5. A small inline `style` adjustment using values from `theme.useToken()`.
6. A reusable, low-level AntD-backed component once the pattern repeats.
7. CSS only when inline styles cannot express the requirement cleanly.

Prefer `Flex`/`Space` and AntD props for routine layout. If styling is necessary, inline `style`
props are preferred over a CSS file: they keep the deviation local and make token use explicit.
Use `theme.useToken()` systematically for spacing, typography, sizes, radii, colors, surfaces,
borders, and hover/focus/disabled/status values. Agor's `useTheme()` answers theme-mode questions;
it is not the AntD token API.

New first-party CSS files are denied by default. CSS is a documented exception for
pseudo-selectors, media queries, keyframes, third-party internals, rendered semantic content, and
genuine canvas/editor/browser needs. Keep it small and theme-aware; suppress `noFirstPartyCss` at
the file level with the concrete reason. Vast or intricate component CSS is usually evidence that
the wrong AntD primitive or abstraction was chosen. Do not style `.ant-*` internals when public
props or a better primitive can express the design.

In React code, use typed values from `theme.useToken()` rather than spelling
`var(--ant-*)` strings. Raw AntD CSS variables are appropriate inside an approved CSS file or at a
non-React API boundary that accepts only CSS/HTML strings; document that boundary with a narrow
suppression. This keeps normal components coupled to the theme API rather than its configurable
CSS-variable prefix.

## Deviations and exact colors

Keep deviations minimal, reusable, accessible, theme-aware, and documented next to the owning
abstraction. Exact colors are narrow exceptions for theme definitions; centralized
user-selectable or data-visualization palettes; terminal/ANSI output; syntax/diff rendering;
explicit brand assets; and demo-only marketing screenshots. Do not move an ordinary component's
palette into a constants file just to avoid tokens.

## Accessibility and testing

- Preserve keyboard operation, visible focus, accessible names, correct semantic elements, and
  sufficient contrast. Never communicate status by color alone. Prefer AntD's built-in focus,
  disabled, loading, validation, tooltip, and modal behavior.
- Test user-visible behavior and accessibility contracts with Testing Library, following
  [`testing.md`](testing.md). For theme-sensitive changes, exercise dark/custom-theme behavior or
  assert semantic token/component usage rather than a rendered default hex value.
- Run the narrow component tests, Biome on touched files, UI typecheck when practical, and the
  review checklist. Avoid screenshot churn unless the screenshot itself is the contract.

## Review checklist

- [ ] Existing AntD/Agor primitives were searched before adding UI.
- [ ] The chosen AntD component owns the visual states instead of a styled `div` recreating it.
- [ ] A repeated bespoke interaction was reused or extracted.
- [ ] Styling deviations are small, inline where practical, and use `theme.useToken()`.
- [ ] Any CSS is necessary, bounded, and carries a concrete `noFirstPartyCss` exception.
- [ ] Raw `--ant-*` strings appear only in approved CSS or documented non-React boundaries.
- [ ] No `.ant-*` internals are overridden when public APIs suffice.
- [ ] Keyboard, focus, names, contrast, loading, disabled, and error states were considered.
- [ ] Any deviation/exact color has a narrow documented reason and works across supported themes.
- [ ] Focused tests, formatting/lint, and typecheck were run as applicable.

## Prioritized follow-ups

Do these incrementally when the relevant surface is next changed: extract shared action/pin rows
from `SessionFooter`; converge repeated pill treatments; standardize settings-table actions; and
reduce bespoke Knowledge/canvas surface chrome. Preserve real canvas/data-visualization palettes
and avoid a mechanical literal rewrite.
