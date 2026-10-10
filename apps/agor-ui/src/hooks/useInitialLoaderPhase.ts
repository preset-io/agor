import { useEffect, useState } from 'react';

export type LoaderPhase = 'loading' | 'fading' | 'done';

/** How long the loading screen takes to fade out over the mounted workspace. */
export const LOADER_FADE_MS = 280;

interface Options {
  connecting: boolean;
  loading: boolean;
  dataError: string | null;
  mustChangePassword: boolean;
  initialLoadComplete: boolean;
}

/**
 * Phase machine for the initial loading screen.
 *   loading → (all items done) → fading → (LOADER_FADE_MS) → done
 *
 * The workspace mounts as soon as the phase leaves `loading`; the loading
 * screen then fades out on top of it instead of holding the workspace back
 * until the fade has finished. On a slow link every millisecond here is added
 * straight to time-to-content, so there is no extra "all done" hold.
 *
 * Two effects are intentionally split: Effect 1 drives state transitions based
 * on many deps; Effect 2 drives the timer based only on [loaderPhase] so an
 * in-progress fade isn't cancelled by unrelated dep changes.
 *
 * The initialLoadComplete guard in Effect 1 blocks advancing during the
 * pre-fetch window: when the socket first connects, useAgorData briefly
 * returns loading:false (null-client path) before fetchData starts.
 */
export function useInitialLoaderPhase({
  connecting,
  loading,
  dataError,
  mustChangePassword,
  initialLoadComplete,
}: Options): LoaderPhase {
  const [loaderPhase, setLoaderPhase] = useState<LoaderPhase>('loading');

  useEffect(() => {
    if (!connecting && !loading && loaderPhase === 'loading') {
      if (dataError || mustChangePassword) {
        setLoaderPhase('done');
      } else if (initialLoadComplete) {
        setLoaderPhase('fading');
      }
    }
  }, [connecting, loading, loaderPhase, dataError, mustChangePassword, initialLoadComplete]);

  useEffect(() => {
    if (loaderPhase === 'fading') {
      const t = setTimeout(() => setLoaderPhase('done'), LOADER_FADE_MS);
      return () => clearTimeout(t);
    }
  }, [loaderPhase]);

  return loaderPhase;
}
