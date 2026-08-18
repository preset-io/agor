import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildZellijLaunchArgs,
  createReconnectGrace,
  ensurePrivateZellijCacheDirectory,
  forceZellijRepaint,
  waitForZellijReady,
  zellijListingHasSession,
} from './zellij.js';

describe('buildZellijLaunchArgs', () => {
  it('attaches directly when an active or exited session is known', () => {
    expect(buildZellijLaunchArgs('agor-branch', true)).toEqual([
      'attach',
      'agor-branch',
      'options',
      '--on-force-close',
      'quit',
      '--session-serialization',
      'true',
      '--serialize-pane-viewport',
      'true',
      '--scrollback-lines-to-serialize',
      '1000',
      '--serialization-interval',
      '1',
    ]);
  });

  it('uses the serializable new-session path while accepting an active-session race', () => {
    expect(buildZellijLaunchArgs('agor-branch', false)).toEqual([
      '--session',
      'agor-branch',
      'options',
      '--on-force-close',
      'quit',
      '--session-serialization',
      'true',
      '--serialize-pane-viewport',
      'true',
      '--scrollback-lines-to-serialize',
      '1000',
      '--serialization-interval',
      '1',
      '--attach-to-session',
      'true',
    ]);
  });
});

describe('zellijListingHasSession', () => {
  it('recognizes active and exited sessions without prefix collisions', () => {
    const listing = [
      'agor-other [Created 2m ago]',
      'agor-branch [Created 1m ago] (EXITED - attach to resurrect)',
    ].join('\n');
    expect(zellijListingHasSession(listing, 'agor-branch')).toBe(true);
    expect(zellijListingHasSession(listing, 'agor')).toBe(false);
  });
});

describe('ensurePrivateZellijCacheDirectory', () => {
  it('creates and tightens the effective-user resurrection cache to 0700', () => {
    const root = mkdtempSync(join(tmpdir(), 'agor-zellij-cache-'));
    const cache = join(root, '.cache', 'zellij');
    try {
      mkdirSync(cache, { recursive: true, mode: 0o755 });
      ensurePrivateZellijCacheDirectory(cache);
      expect(statSync(cache).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('forceZellijRepaint', () => {
  it('shrinks the row count then restores it to force a SIGWINCH repaint', () => {
    const resize = vi.fn();
    let restore: (() => void) | undefined;
    forceZellijRepaint({ resize }, 100, 40, (fn) => {
      restore = fn;
    });
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(100, 39);
    restore?.();
    expect(resize).toHaveBeenLastCalledWith(100, 40);
  });

  it('nudges upward at the lower bound (1 → 2 → 1) so the size always changes', () => {
    const resize = vi.fn();
    let restore: (() => void) | undefined;
    forceZellijRepaint({ resize }, 80, 1, (fn) => {
      restore = fn;
    });
    expect(resize).toHaveBeenCalledWith(80, 2);
    restore?.();
    expect(resize).toHaveBeenLastCalledWith(80, 1);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when there is no pty', () => {
    expect(() => forceZellijRepaint(null, 80, 24, (fn) => fn())).not.toThrow();
  });

  it('swallows a resize on a pty that died before restore', () => {
    const resize = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('pty gone');
      });
    expect(() => forceZellijRepaint({ resize }, 80, 24, (fn) => fn())).not.toThrow();
  });
});

describe('createReconnectGrace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not tear down immediately on disconnect — it waits out the grace window', () => {
    const connected = false;
    const onGraceElapsed = vi.fn();
    const grace = createReconnectGrace({
      graceMs: 30_000,
      isConnected: () => connected,
      onGraceElapsed,
    });

    grace.onDisconnect();
    expect(grace.isPending()).toBe(true);

    // Still within the window: nothing happens.
    vi.advanceTimersByTime(29_999);
    expect(onGraceElapsed).not.toHaveBeenCalled();

    // Window elapses while still disconnected → tear down.
    vi.advanceTimersByTime(1);
    expect(onGraceElapsed).toHaveBeenCalledTimes(1);
    expect(grace.isPending()).toBe(false);
  });

  it('cancels the teardown when the socket reconnects within the window', () => {
    let connected = false;
    const onGraceElapsed = vi.fn();
    const grace = createReconnectGrace({
      graceMs: 30_000,
      isConnected: () => connected,
      onGraceElapsed,
    });

    grace.onDisconnect();
    // Transport comes back before the window elapses.
    connected = true;
    grace.onReconnect();
    expect(grace.isPending()).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(onGraceElapsed).not.toHaveBeenCalled();
  });

  it('does not tear down if the socket is connected again when the window fires', () => {
    let connected = false;
    const onGraceElapsed = vi.fn();
    const grace = createReconnectGrace({
      graceMs: 30_000,
      isConnected: () => connected,
      onGraceElapsed,
    });

    grace.onDisconnect();
    // Reconnect happens but (hypothetically) the cancel was missed; the
    // window still re-checks liveness before exiting, so no teardown.
    connected = true;
    vi.advanceTimersByTime(30_000);
    expect(onGraceElapsed).not.toHaveBeenCalled();
  });

  it('coalesces repeated disconnects into a single pending window', () => {
    const onGraceElapsed = vi.fn();
    const grace = createReconnectGrace({
      graceMs: 30_000,
      isConnected: () => false,
      onGraceElapsed,
    });

    grace.onDisconnect();
    vi.advanceTimersByTime(20_000);
    grace.onDisconnect(); // must NOT restart the countdown
    vi.advanceTimersByTime(10_000);
    expect(onGraceElapsed).toHaveBeenCalledTimes(1);
  });

  it('tears down when the bridge never becomes healthy again (reconnect without re-auth)', () => {
    // Models a socket that flaps back to transport-connected but never
    // re-authenticates: onReconnect (which zellij.ts only calls after a
    // successful re-auth) is never invoked, so the window still fires.
    let bridgeHealthy = false;
    const onGraceElapsed = vi.fn();
    const grace = createReconnectGrace({
      graceMs: 30_000,
      isConnected: () => bridgeHealthy,
      onGraceElapsed,
    });

    grace.onDisconnect();
    // Transport blips but re-auth keeps failing; bridgeHealthy stays false and
    // onReconnect is never called.
    bridgeHealthy = false;
    vi.advanceTimersByTime(30_000);
    expect(onGraceElapsed).toHaveBeenCalledTimes(1);
  });
});

describe('waitForZellijReady', () => {
  it('resolves true as soon as the probe succeeds, without exhausting attempts', async () => {
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return calls >= 3; // fail twice, then succeed
    });
    const ready = await waitForZellijReady('agor-x', {
      attempts: 10,
      probe,
      sleep: async () => {},
    });
    expect(ready).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('resolves false after exhausting attempts when zellij never comes up', async () => {
    const probe = vi.fn(async () => false);
    const ready = await waitForZellijReady('agor-x', {
      attempts: 4,
      probe,
      sleep: async () => {},
    });
    expect(ready).toBe(false);
    expect(probe).toHaveBeenCalledTimes(4);
  });
});
