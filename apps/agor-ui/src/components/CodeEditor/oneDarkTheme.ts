/**
 * Local rebuild of the @codemirror/theme-one-dark editor *theme spec*.
 *
 * Why this exists: pnpm currently resolves two copies of @codemirror/view —
 * @codemirror/theme-one-dark@6.1.3 pins ^6.0.0 (→ 6.41.0) while
 * @uiw/react-codemirror@4.25.10 brings 6.43.0 for the actual editor. The
 * `theme` and `styleModule` Facets that `EditorView.theme(...)` registers
 * against live in `@codemirror/view`'s module scope, so a theme spec built
 * against the 6.41.0 EditorView is silently ignored by the 6.43.0 editor
 * instance — which manifests as a white line-number gutter in dark mode (the
 * rest of the editor draws transparent over the modal background so the bug
 * only shows on the gutter, where CodeMirror's base theme paints a light
 * strip).
 *
 * Rebuilding the theme spec here, using the `EditorView` re-exported by
 * @uiw/react-codemirror, guarantees the facets match the editor's. The colors
 * are the canonical One Dark palette copied verbatim from
 * @codemirror/theme-one-dark@6.1.3 (MIT) so this stays "native theming, just
 * bound to the right module" rather than ad-hoc CSS.
 *
 * The syntax-highlight half of upstream `oneDark` works fine because
 * @codemirror/language IS deduped — its `HighlightStyle` facets match. We
 * keep using it by spreading the upstream array into our export (the dead
 * upstream theme spec is silently dropped by the editor, and is negligible
 * in bundle size).
 */
import { oneDark as upstreamOneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@uiw/react-codemirror';

const ivory = '#abb2bf';
const stone = '#7d8799';
const darkBackground = '#21252b';
const highlightBackground = '#2c313a';
const background = '#282c34';
const tooltipBackground = '#353a42';
const selection = '#3E4451';
const cursor = '#528bff';

const oneDarkThemeSpec = EditorView.theme(
  {
    '&': {
      color: ivory,
      backgroundColor: background,
    },
    '.cm-content': {
      caretColor: cursor,
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: cursor },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: selection },
    '.cm-panels': { backgroundColor: darkBackground, color: ivory },
    '.cm-panels.cm-panels-top': { borderBottom: '2px solid black' },
    '.cm-panels.cm-panels-bottom': { borderTop: '2px solid black' },
    '.cm-searchMatch': {
      backgroundColor: '#72a1ff59',
      outline: '1px solid #457dff',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: '#6199ff2f',
    },
    '.cm-activeLine': { backgroundColor: '#6699ff0b' },
    '.cm-selectionMatch': { backgroundColor: '#aafe661a' },
    '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
      backgroundColor: '#bad0f847',
    },
    '.cm-gutters': {
      backgroundColor: background,
      color: stone,
      border: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: highlightBackground,
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'transparent',
      border: 'none',
      color: '#ddd',
    },
    '.cm-tooltip': {
      border: 'none',
      backgroundColor: tooltipBackground,
    },
    '.cm-tooltip .cm-tooltip-arrow:before': {
      borderTopColor: 'transparent',
      borderBottomColor: 'transparent',
    },
    '.cm-tooltip .cm-tooltip-arrow:after': {
      borderTopColor: tooltipBackground,
      borderBottomColor: tooltipBackground,
    },
    '.cm-tooltip-autocomplete': {
      '& > ul > li[aria-selected]': {
        backgroundColor: highlightBackground,
        color: ivory,
      },
    },
  },
  { dark: true }
);

export const oneDark = [oneDarkThemeSpec, upstreamOneDark];
