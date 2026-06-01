import { useEffect, useState } from 'react';

export type LoaderPhase = 'loading' | 'complete' | 'fading' | 'done';

interface Options {
  connecting: boolean;
  loading: boolean;
  dataError: string | null;
  mustChangePassword: boolean;
  initialLoadComplete: boolean;
}

/**
 * Phase machine for the initial loading screen.
 *   loading → (all items done) → complete → (250ms) → fading → (280ms) → done
 *
 * Two effects are intentionally split: Effect 1 drives state transitions based
 * on many deps; Effect 2 drives timers based only on [loaderPhase] so an
 * in-progress holdTimer isn't cancelled by unrelated dep changes.
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
        setLoaderPhase('complete');
      }
    }
  }, [connecting, loading, loaderPhase, dataError, mustChangePassword, initialLoadComplete]);

  useEffect(() => {
    if (loaderPhase === 'complete') {
      const t = setTimeout(() => setLoaderPhase('fading'), 250);
      return () => clearTimeout(t);
    }
    if (loaderPhase === 'fading') {
      const t = setTimeout(() => setLoaderPhase('done'), 280);
      return () => clearTimeout(t);
    }
  }, [loaderPhase]);

  return loaderPhase;
}
