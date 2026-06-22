/**
 * Lazy-loaded wrapper around the xterm-backed TerminalModal.
 *
 * The real modal (`TerminalModal.tsx`) statically imports `@xterm/xterm` and
 * its addons (~300KB). It used to be imported eagerly by the app shell, so
 * xterm landed in the initial bundle even though most sessions never open a
 * terminal. This wrapper defers the import until the modal is first opened:
 *
 *  - Until `open` first becomes true we render nothing (a closed modal has no
 *    visible output anyway), so the xterm chunk is never fetched.
 *  - On first open we mount the React.lazy inner inside a Suspense boundary.
 *    Once mounted it stays mounted across subsequent open/close cycles, which
 *    matches the previous always-mounted behaviour (and preserves the close
 *    animation).
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import type { TerminalModalProps } from './TerminalModal';

const TerminalModalInner = lazy(() =>
  import('./TerminalModal').then((m) => ({ default: m.TerminalModal }))
);

export const TerminalModal: React.FC<TerminalModalProps> = (props) => {
  const [hasOpened, setHasOpened] = useState(props.open);

  useEffect(() => {
    if (props.open) setHasOpened(true);
  }, [props.open]);

  if (!hasOpened) return null;

  return (
    <Suspense fallback={null}>
      <TerminalModalInner {...props} />
    </Suspense>
  );
};
