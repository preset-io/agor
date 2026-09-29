/**
 * Lazily load a modal-like component the first time it is opened.
 *
 * Many surfaces mount their modals up front with `open={false}`. Importing
 * them statically puts each modal's whole dependency graph (settings tables,
 * Markdown/Streamdown, the emoji picker, MCP editors, …) in the chunk that
 * has to download before the workspace can render, which dominates load time
 * on a slow link.
 *
 * The wrapper renders nothing until `open` first becomes true (a closed modal
 * has no visible output), then mounts the lazy module inside a Suspense
 * boundary and keeps it mounted across later open/close cycles, so component
 * state and close animations behave exactly as with a static import. This is
 * the pattern `TerminalModalLazy` introduced for xterm.
 */
import { type ComponentType, lazy, Suspense, useEffect, useState } from 'react';

export function lazyWhenOpened<P extends { open?: boolean }>(
  load: () => Promise<ComponentType<P>>
): ComponentType<P> {
  const Inner = lazy(async () => ({ default: await load() }));

  function LazyWhenOpened(props: P) {
    const [hasOpened, setHasOpened] = useState(!!props.open);

    useEffect(() => {
      if (props.open) setHasOpened(true);
    }, [props.open]);

    if (!hasOpened) return null;

    return (
      <Suspense fallback={null}>
        <Inner {...props} />
      </Suspense>
    );
  }

  return LazyWhenOpened;
}
