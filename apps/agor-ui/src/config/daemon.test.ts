import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * getDaemonUrl() resolution order matters for the split-port branch dev env
 * (issue #1576): vite-dev serves the UI on UI_PORT while the daemon API lives
 * on DAEMON_PORT, so the SPA must POST /authentication to the daemon — not to
 * its own origin. These tests lock in that an explicit VITE_DAEMON_URL wins
 * before any same-origin assumption, while production (bundled UI under /ui)
 * keeps talking to its own origin.
 */

const originalLocation = window.location;

function setLocation(href: string): void {
  Object.defineProperty(window, 'location', {
    value: new URL(href),
    writable: true,
    configurable: true,
  });
}

// DEFAULT_DAEMON_URL is computed at module import, so each case re-imports the
// module after stubbing env + location.
async function loadGetDaemonUrl(): Promise<() => string> {
  vi.resetModules();
  const mod = await import('./daemon');
  return mod.getDaemonUrl;
}

describe('getDaemonUrl', () => {
  beforeEach(() => {
    // Ensure a clean slate; individual tests stub what they need.
    vi.stubEnv('VITE_DAEMON_URL', '');
    vi.stubEnv('VITE_DAEMON_PORT', '3030');
    vi.stubEnv('BASE_URL', '/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('prefers an explicit VITE_DAEMON_URL in the split-port dev env', async () => {
    // UI on :14069, daemon on :12069 — the dev variant injects VITE_DAEMON_URL.
    vi.stubEnv('VITE_DAEMON_URL', 'http://10.33.92.175:12069');
    setLocation('http://10.33.92.175:14069/');

    const getDaemonUrl = await loadGetDaemonUrl();
    expect(getDaemonUrl()).toBe('http://10.33.92.175:12069');
  });

  it('keeps the same-origin daemon for the bundled production UI (/ui base)', async () => {
    // Production: daemon serves UI + API on one origin; base is /ui/.
    vi.stubEnv('BASE_URL', '/ui/');
    setLocation('https://agor.example.com/ui/login');

    const getDaemonUrl = await loadGetDaemonUrl();
    expect(getDaemonUrl()).toBe('https://agor.example.com');
  });

  it('derives the daemon port for root vite-dev when no explicit URL is set', async () => {
    // Fallback path: no VITE_DAEMON_URL, root base — swap UI port for daemon port.
    vi.stubEnv('VITE_DAEMON_PORT', '12069');
    setLocation('http://10.33.92.175:14069/');

    const getDaemonUrl = await loadGetDaemonUrl();
    expect(getDaemonUrl()).toBe('http://10.33.92.175:12069');
  });
});
