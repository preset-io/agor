/**
 * React hook for updating favicon based on session activity
 *
 * Updates favicon with dot overlays to indicate status:
 * - White dot (lower-left): Agent actively working
 * - Green dot (lower-right): Ready for prompt (completed work, needs attention)
 * - No dots: Nothing active on current board
 */

import { theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { brandMarkHref } from '../branding/brand';
import { agorStore, shallow, useStoreWithEqualityFn } from '../store/agorStore';
import { makeBoardSessionActivitySelector } from '../store/selectors';
import { createFaviconWithDot } from '../utils/faviconDot';

export function useFaviconStatus(currentBoardId: string | null) {
  const [baseFaviconUrl] = useState(brandMarkHref());
  const { token } = theme.useToken();

  // Subscribe to the two derived flags rather than the whole session /
  // board-object maps: the favicon only changes when a flag flips, so the
  // host component stays quiet across ordinary session churn.
  const { hasRunning, hasReady } = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => makeBoardSessionActivitySelector(currentBoardId), [currentBoardId]),
    shallow
  );

  useEffect(() => {
    // createFaviconWithDot is async (it decodes an <img> and rasterizes to a
    // canvas). If it resolves after this effect re-runs or the Workspace shell
    // unmounts (e.g. navigating to a static surface that pins its own favicon),
    // applying the stale result would clobber the new favicon. Guard with a
    // cancellation flag cleared on cleanup.
    let cancelled = false;
    const applyFavicon = (dataUrl: string) => {
      if (cancelled) return;
      const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
      if (link) {
        link.href = dataUrl;
      }
    };

    // Update favicon with appropriate dots (both false with no board —
    // the selector reports no activity — restoring the default favicon).
    // White dot (lower-left) for running, green dot (lower-right) for ready
    createFaviconWithDot(baseFaviconUrl, hasRunning, hasReady, token.colorSuccessText).then(
      applyFavicon
    );

    return () => {
      cancelled = true;
    };
  }, [hasRunning, hasReady, baseFaviconUrl, token.colorSuccessText]);
}
