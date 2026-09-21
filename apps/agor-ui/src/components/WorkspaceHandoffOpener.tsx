import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMCPCatalogModal } from '../contexts/MCPCatalogModalContext';

// Global search opens on Cmd/Ctrl+K via a window keydown listener it registers
// on mount. On a cold desktop load the header mounts after this opener, so a
// single dispatch can race ahead of that listener; retry a few times over ~1s.
function openGlobalSearchWhenReady() {
  let attempts = 0;
  const fire = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    attempts += 1;
    if (attempts < 6) window.setTimeout(fire, 200);
  };
  requestAnimationFrame(fire);
}

/**
 * Opens the desktop surface a mobile tab maps to when the viewport crosses the
 * shell breakpoint. The MCP catalog and global search are modals, not routes, so
 * `responsiveRoutePath` hands off `/?open=mcp-catalog` / `/?open=search`; this
 * consumes that flag once, opens the matching surface, and strips the flag so a
 * refresh or Back does not re-open it. Absent the flag it is inert, so desktop
 * behaviour is unchanged for everyone who did not come from a mobile tab.
 */
export function WorkspaceHandoffOpener() {
  const catalog = useMCPCatalogModal();
  const [params, setParams] = useSearchParams();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const target = params.get('open');
    if (target === 'mcp-catalog') {
      // The catalog controller mounts with the provider; wait for it.
      if (!catalog) return;
      catalog.openCatalog();
    } else if (target === 'search') {
      // Reuse global search's existing Cmd/Ctrl+K open path (a window keydown
      // listener) rather than threading a new imperative handle through the
      // header, retrying to beat the header's mount on a cold load.
      openGlobalSearchWhenReady();
    } else {
      return;
    }
    handled.current = true;
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next, { replace: true });
  }, [params, catalog, setParams]);

  return null;
}
