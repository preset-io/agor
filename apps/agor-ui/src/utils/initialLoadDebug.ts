const DEBUG_INITIAL_LOAD_STORAGE_KEY = 'agor.debug.initialLoad';

export interface InitialLoadDebugItem {
  key: string;
  label: string;
}

export interface InitialLoadDebugFetchTiming {
  key: string;
  label: string;
  durationMs: number;
  count: number | null;
  status: 'success' | 'error';
  error?: string;
}

export interface InitialLoadDebugStageTransition {
  stage: string;
  atMs: number;
}

export interface InitialLoadDebugTimings {
  label: string;
  startedAt: string;
  totalMs: number;
  fetchPhaseMs: number | null;
  indexingMs: number | null;
  status: 'success' | 'error';
  error?: string;
  fetches: InitialLoadDebugFetchTiming[];
  stageTransitions: InitialLoadDebugStageTransition[];
}

type DebugWindow = Window & {
  __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings;
};

function getWindow(): DebugWindow | null {
  return typeof window === 'undefined' ? null : (window as DebugWindow);
}

function getNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function syncInitialLoadDebugFlagFromUrl(win = getWindow()): boolean {
  if (!win) return false;

  let value: string | null = null;
  try {
    value = new URLSearchParams(win.location.search).get('debugLoad');
  } catch {
    value = null;
  }

  try {
    if (value === '1') {
      win.localStorage.setItem(DEBUG_INITIAL_LOAD_STORAGE_KEY, '1');
    } else if (value === '0') {
      win.localStorage.removeItem(DEBUG_INITIAL_LOAD_STORAGE_KEY);
    }

    return win.localStorage.getItem(DEBUG_INITIAL_LOAD_STORAGE_KEY) === '1';
  } catch {
    return value === '1';
  }
}

export function isInitialLoadDebugEnabled(): boolean {
  return syncInitialLoadDebugFlagFromUrl();
}

export function createInitialLoadDebugTimer(items: readonly InitialLoadDebugItem[]) {
  const start = getNow();
  const startedAt = new Date().toISOString();
  const labels = new Map(items.map((item) => [item.key, item.label]));
  const fetches: InitialLoadDebugFetchTiming[] = [];
  const stageTransitions: InitialLoadDebugStageTransition[] = [];
  let fetchStart: number | null = null;
  let fetchEnd: number | null = null;
  let indexingStart: number | null = null;
  let indexingEnd: number | null = null;

  const markStage = (stage: string) => {
    stageTransitions.push({ stage, atMs: roundMs(getNow() - start) });
  };

  return {
    markStage,
    startFetchPhase() {
      fetchStart = getNow();
    },
    endFetchPhase() {
      fetchEnd = getNow();
    },
    startIndexing() {
      indexingStart = getNow();
    },
    endIndexing() {
      indexingEnd = getNow();
    },
    track<T extends ReadonlyArray<unknown>>(key: string, promise: Promise<T>): Promise<T> {
      const itemStart = getNow();
      return promise.then(
        (result) => {
          fetches.push({
            key,
            label: labels.get(key) ?? key,
            durationMs: roundMs(getNow() - itemStart),
            count: result.length,
            status: 'success',
          });
          return result;
        },
        (error) => {
          fetches.push({
            key,
            label: labels.get(key) ?? key,
            durationMs: roundMs(getNow() - itemStart),
            count: null,
            status: 'error',
            error: errorMessage(error),
          });
          throw error;
        }
      );
    },
    finish(status: 'success' | 'error', error?: unknown): InitialLoadDebugTimings {
      const timings: InitialLoadDebugTimings = {
        label: 'Agor initial load',
        startedAt,
        totalMs: roundMs(getNow() - start),
        fetchPhaseMs: fetchStart === null ? null : roundMs((fetchEnd ?? getNow()) - fetchStart),
        indexingMs:
          indexingStart === null ? null : roundMs((indexingEnd ?? getNow()) - indexingStart),
        status,
        error: error === undefined ? undefined : errorMessage(error),
        fetches: [...fetches].sort((a, b) => a.key.localeCompare(b.key)),
        stageTransitions: [...stageTransitions],
      };

      const win = getWindow();
      if (win) {
        win.__AGOR_INITIAL_LOAD_TIMINGS__ = timings;
      }

      if (typeof console !== 'undefined') {
        const group = console.groupCollapsed ?? console.group;
        group?.call(console, '[Agor initial load]', {
          status: timings.status,
          totalMs: timings.totalMs,
          fetchPhaseMs: timings.fetchPhaseMs,
          indexingMs: timings.indexingMs,
        });
        console.table?.(timings.fetches);
        if (timings.stageTransitions.length > 0) {
          console.log('stageTransitions', timings.stageTransitions);
        }
        if (timings.error) {
          console.warn('[Agor initial load] failed', timings.error);
        }
        console.log('Copy from window.__AGOR_INITIAL_LOAD_TIMINGS__', timings);
        console.groupEnd?.();
      }

      return timings;
    },
  };
}
