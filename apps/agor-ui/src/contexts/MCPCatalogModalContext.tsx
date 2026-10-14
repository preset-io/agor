import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

/**
 * A request to open the Catalog drawer for one entry, outside the Catalog
 * modal, and hand back to the requester once that entry is connected. The
 * in-conversation Connect card uses it so its connect is the Catalog's own.
 */
export interface MCPCatalogEntryHandoff {
  entryName: string;
  /** What the drawer's copy says the user returns to. */
  returnTo: string;
  onConnected: (serverId: string) => void;
  onClose?: () => void;
}

interface MCPCatalogModalController {
  mounted: boolean;
  open: boolean;
  openCatalog: (returnFocus?: HTMLElement | null) => void;
  closeCatalog: () => void;
  afterClose: () => void;
  dismissForNavigation: () => void;
  entryHandoff: MCPCatalogEntryHandoff | null;
  openCatalogEntry: (handoff: MCPCatalogEntryHandoff) => void;
  closeCatalogEntry: () => void;
}

const MCPCatalogModalContext = createContext<MCPCatalogModalController | null>(null);

/** Provider-free marketing fixtures omit Catalog actions instead of owning a second host. */
export const useMCPCatalogModal = () => useContext(MCPCatalogModalContext);

export function MCPCatalogModalProvider({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [entryHandoff, setEntryHandoff] = useState<MCPCatalogEntryHandoff | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const openCatalog = useCallback((returnFocus?: HTMLElement | null) => {
    returnFocusRef.current =
      returnFocus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setMounted(true);
    setOpen(true);
  }, []);
  const closeCatalog = useCallback(() => setOpen(false), []);
  const afterClose = useCallback(() => {
    if (open) return;
    setMounted(false);
    const trigger = returnFocusRef.current;
    returnFocusRef.current = null;
    if (trigger?.isConnected) trigger.focus();
  }, [open]);
  const dismissForNavigation = useCallback(() => {
    // Navigation owns destination focus. Never refocus the departing session.
    returnFocusRef.current = null;
    setOpen(false);
    setMounted(false);
    setEntryHandoff(null);
  }, []);
  const openCatalogEntry = useCallback(
    (handoff: MCPCatalogEntryHandoff) => setEntryHandoff(handoff),
    []
  );
  const closeCatalogEntry = useCallback(() => setEntryHandoff(null), []);
  const value = useMemo(
    () => ({
      mounted,
      open,
      openCatalog,
      closeCatalog,
      afterClose,
      dismissForNavigation,
      entryHandoff,
      openCatalogEntry,
      closeCatalogEntry,
    }),
    [
      mounted,
      open,
      openCatalog,
      closeCatalog,
      afterClose,
      dismissForNavigation,
      entryHandoff,
      openCatalogEntry,
      closeCatalogEntry,
    ]
  );
  return (
    <MCPCatalogModalContext.Provider value={value}>{children}</MCPCatalogModalContext.Provider>
  );
}
