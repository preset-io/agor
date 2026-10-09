import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isDynamicImportFailure,
  reloadForStaleChunk,
  STALE_CHUNK_RELOAD_KEY,
  STALE_CHUNK_RELOAD_WINDOW_MS,
} from './staleChunkReload';

describe('isDynamicImportFailure', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/ui/assets/ArtifactNode-C5Z75nfP.js',
    'error loading dynamically imported module: https://x/ui/assets/a.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /ui/assets/a.css',
  ])('recognizes %s', (message) => {
    expect(isDynamicImportFailure(new TypeError(message))).toBe(true);
  });

  it('ignores ordinary render errors and non-errors', () => {
    expect(
      isDynamicImportFailure(new TypeError("Cannot read properties of undefined (reading 'id')"))
    ).toBe(false);
    expect(isDynamicImportFailure('Failed to fetch dynamically imported module')).toBe(false);
  });
});

describe('reloadForStaleChunk', () => {
  const stale = (hash: string) =>
    new TypeError(
      `Failed to fetch dynamically imported module: https://x/ui/assets/ArtifactNode-${hash}.js`
    );
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reloads once, then defers to the crash screen when the same chunk fails again', () => {
    expect(reloadForStaleChunk(stale('C5Z75nfP'), 1_000_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(
      reloadForStaleChunk(stale('C5Z75nfP'), 1_000_000 + STALE_CHUNK_RELOAD_WINDOW_MS - 1)
    ).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again for a different chunk, as after a second deploy', () => {
    reloadForStaleChunk(stale('C5Z75nfP'), 1_000_000);
    expect(reloadForStaleChunk(stale('Nr2CCbiH'), 1_000_001)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('reloads again for the same failure once the window has passed', () => {
    reloadForStaleChunk(stale('C5Z75nfP'), 1_000_000);
    expect(reloadForStaleChunk(stale('C5Z75nfP'), 1_000_000 + STALE_CHUNK_RELOAD_WINDOW_MS)).toBe(
      true
    );
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('ignores an unreadable stored record', () => {
    window.sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, 'not json');
    expect(reloadForStaleChunk(stale('C5Z75nfP'), 1_000_000)).toBe(true);
  });

  it('does not reload while offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(reloadForStaleChunk(stale('C5Z75nfP'), 1_000_000)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when the guard cannot be stored', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(reloadForStaleChunk(stale('C5Z75nfP'), 1_000_000)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
