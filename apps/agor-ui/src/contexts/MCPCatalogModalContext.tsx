import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface MCPCatalogModalController {
  mounted: boolean;
  open: boolean;
  openCatalog: (returnFocus?: HTMLElement | null) => void;
  closeCatalog: () => void;
  afterClose: () => void;
  dismissForNavigation: () => void;
}

const MCPCatalogModalContext = createContext<MCPCatalogModalController | null>(null);

/** Provider-free marketing fixtures omit Catalog actions instead of owning a second host. */
export const useMCPCatalogModal = () => useContext(MCPCatalogModalContext);

export function MCPCatalogModalProvider({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
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
  }, []);
  const value = useMemo(
    () => ({ mounted, open, openCatalog, closeCatalog, afterClose, dismissForNavigation }),
    [mounted, open, openCatalog, closeCatalog, afterClose, dismissForNavigation]
  );
  return (
    <MCPCatalogModalContext.Provider value={value}>{children}</MCPCatalogModalContext.Provider>
  );
}
