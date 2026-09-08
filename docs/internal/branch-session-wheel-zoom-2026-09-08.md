# BranchCard session-tree wheel zoom

## Reproduction and cause

Max reported browser-page zoom instead of board zoom with the pointer over a
session row. Reproduced the event-routing failure in real Chromium using the
actual BranchCard/Ant Design tree inside React Flow 11.11.4, with SessionCanvas's
pan/zoom settings. No daemon, seeded tenant data, or app environment was needed;
the existing Vitest/Playwright browser runner owns its temporary test server.

Inspected recent history, not just the symptom: `74e96187` / #2687 changed the tree
from `agor-flat-tree` to `agor-flat-tree nodrag nowheel`, with `height=400` and
virtualization. It also introduced bounded `PagedSessions` with `nowheel`.
Virtualization must stay: removing it or removing `nowheel` breaks bounded
rendering or ordinary inner scrolling.

Routing with installed React 19.2.8 / `@rc-component/virtual-list` 1.5.1:

1. SessionCanvas enables `panOnScroll` in select mode and
   `zoomActivationKeyCode={['Meta', 'Control']}`. Plain wheel pans the board;
   modifier wheel zooms. Trackpad pinch is represented by Ctrl+wheel **without
   necessarily any keydown**. React Flow handles that directly in its pan-wheel
   listener. Meta uses its keydown/keyup activation state. Its delta conversion
   also accounts for deltaMode and macOS Ctrl scaling.
2. React Flow installs a **native, non-passive bubble** wheel listener on
   `.react-flow__renderer`. Both pan and zoom paths return immediately for a
   `nowheel` ancestor, **before** `preventDefault`. `nopan` is a pointer-pan
   exclusion, not an override of `nowheel`; `nodrag` controls node dragging.
3. The virtual tree installs its own **native, non-passive** wheel listener on
   `.ant-tree-list-holder`. It does not check Ctrl/Meta. In an overflowing tree
   it can preventDefault and schedule scrolling via RAF; at an outward edge it
   can return without canceling. In a short tree it returns without handling.
   It uses `_virtualHandled` for nested virtual lists, not stopPropagation.
4. Thus small-tree/edge zoom gestures reach React Flow but fail its `nowheel`
   filter and leave browser zoom uncanceled. Inside overflow, pinch can instead
   scroll the list. These are two manifestations of the same ownership error.
   The card's row/action stopPropagation handlers concern clicks, not wheels.
   Peek's passive wheel listener only records scroll intent.
5. React's root-delegated wheel listeners are passive. Adding a React
   `onWheelCapture` with preventDefault is not a reliable cancellation fix;
   bubble handlers also run too late to prevent the native virtual-list handler.

## Targeted fix

`useBranchCardWheelZoom` adds one native `{capture:true, passive:false}` listener
to a canvas BranchCard, with cleanup. It handles only Ctrl/Meta wheel from a
`nowheel` descendant of that card and only if there is an ancestor React Flow
renderer. Panel/popover cards explicitly opt out; standalone cards are inert.

It cancels/stops the original event before virtual-list scrolling, then forwards
a WheelEvent with the original coordinates, modifiers, deltas, and deltaMode to
that renderer. React Flow remains the only zoom implementation: pointer anchoring,
platform scaling, limits, and viewport callbacks are retained. The forwarded
event does not descend into the card, so there is no recursion. No DOM classes
are temporarily removed, no modifier is invented, and no document/window or
keyboard interception is installed. Cancellation also holds at zoom limits.

Plain/Shift/Alt wheel, clicks, focus, selection, dragging, tree virtualization,
and pagination are unchanged. Other cards' `nowheel` areas (including Markdown
previews) are untouched. The listener also covers BranchCard's native-scroll
scheduled rows/pagination and peek/preview areas rather than fixing only one row.

Tenant review: this is synchronous DOM input routing over already-rendered data.
It adds no persistence, fetching, resource lookup, shared cache, identity source,
authorization decision, or API/realtime boundary. No cross-tenant negative test
is applicable; existing boundary guards were run. Large existing components were
not refactored for this small fix; the event logic is isolated in a small hook.

## Before/after browser evidence

Cancelable pinch-form events (`ctrlKey:true`, no keydown, deltaY=-50, Linux
Chromium), with initial canvas zoom 0.7:

| Pointer                          | Before                           | After                           |
| -------------------------------- | -------------------------------- | ------------------------------- |
| Blank canvas                     | canceled; zoom 0.7502414         | unchanged behavior              |
| BranchCard header                | canceled; canvas zoom increases  | unchanged behavior              |
| Session row, 2 sessions          | **uncanceled; zoom stays 0.7**   | canceled; zoom 0.7502414        |
| Session row, 100 sessions at top | **uncanceled; zoom stays 0.7**   | canceled; canvas zoom increases |
| Tree scroll holder               | **uncanceled; canvas unchanged** | canceled; canvas zoom increases |
| React Flow zoom-control panel    | uncanceled; canvas unchanged     | unchanged (sibling of renderer) |

Before the fix, both row/tree cases failed the regression assertions while
trusted plain-wheel inner scrolling passed. The post-fix suite additionally uses
Playwright's **trusted mouse wheel with held Control and Meta**: it observes the
original `isTrusted` wheel at document capture (test instrumentation only), then
asserts `defaultPrevented`, increased React Flow zoom, changed rendered
`.react-flow__viewport` transform, and unchanged inner scrollTop=150.

Tests also cover pinch in/out at scroll/zoom limits, scheduled native scrolling
and pagination controls, plain canvas panning, session click/Enter activation,
row-vs-header drag, zoom-button clicks, outside-canvas wheel and +/-/0 keyboard
non-cancellation, listener cleanup, and preservation of line-mode wheel payloads.

## Validation

```sh
pnpm --filter agor-ui test src/components/BranchCard src/components/SessionCanvas/SessionCanvas.zoom.test.tsx
# 46 passed (9 files)

pnpm --filter agor-ui test:browser src/components/BranchCard/BranchCard.wheel.browser.test.tsx src/components/BranchCard/BranchSessionSections.bounds.browser.test.tsx src/components/CardNode/CardNode.markdown.browser.test.tsx
# 64 passed (12 files): Chromium desktop, phone, tablet, short-landscape

pnpm --filter agor-ui lint
# Passed; four pre-existing informational diagnostics, no warnings/errors
pnpm check:multitenancy-boundaries
pnpm check:realtime-boundaries
pnpm check:daemon-filesystem-boundaries
pnpm check:shortid
# All passed
```

`pnpm --filter agor-ui typecheck` was attempted but the fresh checkout has no
generated `@agor-live/client` / `@agor/core` declarations. No build was run.
Both UI projects instead pass strict no-emit checking against workspace source:

```sh
pnpm --filter agor-ui exec tsc -p tsconfig.app.json --customConditions source --erasableSyntaxOnly false --noEmit --pretty false
pnpm --filter agor-ui exec tsc -p tsconfig.node.json --customConditions source --erasableSyntaxOnly false --noEmit --pretty false
```

`erasableSyntaxOnly` is disabled only for this invocation because the imported
core source uses enums/parameter properties normally hidden by its declarations;
strict typing remains enabled. The two new tests also pass a temporary no-emit
config extending the UI config with the same source options, `exclude:[]`, and
only those tests included (UI's normal config excludes tests). No permanent
configuration changes or emitted artifacts are part of this fix.

## Limits and manual verification still needed

DOM-dispatched WheelEvents are untrusted and cannot themselves trigger browser
chrome zoom. Playwright/CDP wheel is trusted and proves original-event
cancellation plus real canvas transforms/scrolling, but headless Chromium's
iframe test harness is **not** proof of physical trackpad behavior or browser
toolbar zoom percentage. No physical trackpad or Safari/Firefox run was made.

Before merging, manually verify macOS trackpad pinch and Command+scroll, and
Windows/Linux Ctrl+wheel/trackpad pinch, in the full board shell. Compare blank
canvas, card header, rows/action controls, short/overflowing trees (top/middle/end),
scheduled pages, and peek scroll areas. Canvas should zoom around the cursor
without changing browser zoom or inner scroll; ordinary scrolling should stay
inside the tree. Check normal clicks, expand/collapse, selection and header drag.
Verify Ctrl/Command +/-/0 and browser accessibility zoom outside the canvas still
work. Native OS magnification and Safari gesture events are not newly intercepted.

No merge or production deployment was performed.
