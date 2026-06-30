/**
 * Lazy-loaded wrapper around the xterm-backed EmbeddedTerminal.
 *
 * `EmbeddedTerminal.tsx` statically imports `@xterm/xterm` and its addons
 * (~300KB, shared with TerminalModal). Wrapping it in React.lazy keeps xterm
 * off the always-loaded session panel chunk and defers its import to the first
 * render of an embedded terminal, which only `claude-code-cli` sessions ever
 * trigger. The public API matches EmbeddedTerminal exactly.
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
