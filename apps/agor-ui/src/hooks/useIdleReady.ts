import { useEffect, useState } from 'react';

/**
 * Flips to true once the browser is idle (or after `timeout` ms). Lists use one
 * flag to mount deferred per-row chrome in a single commit instead of scheduling
 * an idle callback per row.
 */
export function useIdleReady(enabled = true, timeout = 1000): boolean {
  const [ready, setReady] = useState(!enabled);
  useEffect(() => {
    if (ready) return;
    const markReady = () => setReady(true);
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(markReady, { timeout });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(markReady, Math.min(timeout, 300));
    return () => clearTimeout(timer);
  }, [ready, timeout]);
  return ready;
}
