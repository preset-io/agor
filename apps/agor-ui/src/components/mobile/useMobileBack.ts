import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Back to where the user came from; when there is no in-app history (a cold
 * deep-link) it goes to `fallback` instead of leaving the app.
 *
 * "No in-app history" is detected primarily from the router's history index
 * (`window.history.state.idx`, 0 on the first entry). That is more robust than
 * the location key because a device-shell redirect (`/s/:id` → `/m/session/:id`
 * via `navigate(..., { replace: true })`) mints a fresh key while keeping idx 0:
 * a key-only check would then `navigate(-1)` straight back into the redirect and
 * the tap would appear dead. The index is available immediately, so Back works
 * before the session/branch/board have resolved. When the index is unavailable
 * (e.g. the in-memory router used in unit tests) we fall back to the key.
 */
export function useMobileBack(fallback: string): () => void {
  const navigate = useNavigate();
  const { key } = useLocation();
  return useCallback(() => {
    const historyIndex =
      typeof window !== 'undefined' ? (window.history.state?.idx as number | undefined) : undefined;
    const hasInAppHistory = historyIndex != null ? historyIndex > 0 : key !== 'default';
    if (hasInAppHistory) navigate(-1);
    else navigate(fallback);
  }, [navigate, key, fallback]);
}
