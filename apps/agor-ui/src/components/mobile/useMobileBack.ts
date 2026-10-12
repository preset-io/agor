import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { backOr, hasInAppHistory } from '../../utils/uiRoutes';

/** Back to where the user came from; with no in-app history (a deep link, even one redirected) it replaces itself with `fallback` instead. */
export function useMobileBack(fallback: string): () => void {
  const navigate = useNavigate();
  const { key } = useLocation();
  return useCallback(
    () => backOr(navigate, hasInAppHistory(key), fallback),
    [navigate, key, fallback]
  );
}
