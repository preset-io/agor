import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** Back to where the user came from; the router's untouched initial entry has no in-app history, so it goes to `fallback` instead. */
export function useMobileBack(fallback: string): () => void {
  const navigate = useNavigate();
  const { key } = useLocation();
  return useCallback(() => {
    if (key !== 'default') navigate(-1);
    else navigate(fallback);
  }, [navigate, key, fallback]);
}
