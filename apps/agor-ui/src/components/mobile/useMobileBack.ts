import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { hasInAppHistory } from '../../utils/uiRoutes';

/** Back to where the user came from; with no in-app history (a deep link, even one redirected) it goes to `fallback` instead. */
export function useMobileBack(fallback: string): () => void {
  const navigate = useNavigate();
  const { key } = useLocation();
  return useCallback(() => {
    if (hasInAppHistory(key)) navigate(-1);
    else navigate(fallback);
  }, [navigate, key, fallback]);
}
