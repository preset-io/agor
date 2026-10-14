import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { RELOAD_FALLBACK_MS, STALE_CHUNK_RELOAD_KEY } from './staleChunkReload';

const chunkError = new TypeError(
  'Failed to fetch dynamically imported module: http://localhost/ui/assets/ArtifactNode-C5Z75nfP.js'
);

function Throw({ error }: { error: Error }): never {
  throw error;
}

describe('ErrorBoundary stale chunk recovery', () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reloads instead of showing the crash screen when a lazy chunk fails', () => {
    render(
      <ErrorBoundary variant="global">
        <Throw error={chunkError} />
      </ErrorBoundary>
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Reloading…')).toBeInTheDocument();
    expect(screen.queryByText("Well, that wasn't supposed to happen.")).not.toBeInTheDocument();
  });

  it('falls back to the crash screen when the reload is cancelled', () => {
    vi.useFakeTimers();
    try {
      render(
        <ErrorBoundary variant="global">
          <Throw error={chunkError} />
        </ErrorBoundary>
      );
      expect(screen.getByText('Reloading…')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(RELOAD_FALLBACK_MS);
      });
      expect(screen.getByText("Well, that wasn't supposed to happen.")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the crash screen when the chunk still fails right after a reload', () => {
    window.sessionStorage.setItem(
      STALE_CHUNK_RELOAD_KEY,
      JSON.stringify({ message: chunkError.message, at: Date.now() })
    );
    render(
      <ErrorBoundary variant="global">
        <Throw error={chunkError} />
      </ErrorBoundary>
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("Well, that wasn't supposed to happen.")).toBeInTheDocument();
  });

  it('keeps the crash screen for ordinary render errors', () => {
    render(
      <ErrorBoundary variant="global">
        <Throw error={new Error('boom')} />
      </ErrorBoundary>
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("Well, that wasn't supposed to happen.")).toBeInTheDocument();
  });

  it('leaves scoped boundaries inline', () => {
    render(
      <ErrorBoundary>
        <Throw error={chunkError} />
      </ErrorBoundary>
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('Something went wrong rendering this view.')).toBeInTheDocument();
  });
});
