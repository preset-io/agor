/**
 * Lazy-loaded wrapper around the xterm-backed EmbeddedTerminal.
 *
 * `EmbeddedTerminal.tsx` statically imports `@xterm/xterm` and its addons
 * (~300KB, shared with TerminalModal). It used to be imported eagerly by
 * SessionPanelContent, pulling xterm into the always-loaded session panel
 * chunk even though only `claude-code-cli` sessions ever render it. Wrapping
 * it in React.lazy defers the xterm import to the first render of an embedded
 * terminal. The public API matches EmbeddedTerminal exactly.
 */
import { lazy, Suspense } from 'react';
import type { EmbeddedTerminalProps } from './EmbeddedTerminal';

const EmbeddedTerminalInner = lazy(() =>
  import('./EmbeddedTerminal').then((m) => ({ default: m.EmbeddedTerminal }))
);

export const EmbeddedTerminal: React.FC<EmbeddedTerminalProps> = (props) => (
  <Suspense fallback={null}>
    <EmbeddedTerminalInner {...props} />
  </Suspense>
);
