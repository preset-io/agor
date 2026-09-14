import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildZellijLaunchArgs,
  createReconnectGrace,
  createTerminalInputGate,
  ensurePrivateZellijCacheDirectory,
  forceZellijRepaint,
  waitForTerminalOutputSettled,
  waitForZellijReady,
  zellijListingHasSession,
} from './zellij.js';

describe('createTerminalInputGate', () => {
  it('flushes startup input in order and passes later input through', () => {
    const write = vi.fn();
    const gate = createTerminalInputGate(write);

    expect(gate.write('echo one\r')).toBe(true);
    expect(gate.write('echo two\r')).toBe(true);
    expect(write).not.toHaveBeenCalled();

    gate.open();
    expect(write.mock.calls.map(([input]) => input)).toEqual(['echo one\r', 'echo two\r']);
    expect(gate.isOpen()).toBe(true);

    expect(gate.write('pwd\r')).toBe(true);
    expect(write).toHaveBeenLastCalledWith('pwd\r');
  });

  it('bounds pending UTF-8 input without affecting an open gate', () => {
    const write = vi.fn();
    const gate = createTerminalInputGate(write, 4);

    expect(gate.write('é')).toBe(true); // two UTF-8 bytes
    expect(gate.write('🙂')).toBe(false); // four more bytes would exceed the bound
    gate.open();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('é');

    expect(gate.write('🙂')).toBe(true);
    expect(write).toHaveBeenLastCalledWith('🙂');
  });

  it('passes terminal-emulator protocol responses through during startup', () => {
    const write = vi.fn();
    const gate = createTerminalInputGate(write, 1024, (input) => input.startsWith('\u001b'));

    gate.write('echo queued\r');
    gate.write('\u001b]4;0;rgb:0000/0000/0000\u001b\\');
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('\u001b]4;0;rgb:0000/0000/0000\u001b\\');

    gate.open();
    expect(write).toHaveBeenLastCalledWith('echo queued\r');
  });

  it('drops pending input when startup fails', () => {
    const write = vi.fn();
    const gate = createTerminalInputGate(write);
    gate.write('should-not-run\r');
    gate.clear();
    gate.open();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('waitForTerminalOutputSettled', () => {
  it('waits for output and a full quiet window', async () => {
    let now = 0;
    let lastOutputAt: number | null = null;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
      if (now === 50) lastOutputAt = now;
      if (now === 100) lastOutputAt = now;
    });

    const settled = await waitForTerminalOutputSettled(() => lastOutputAt, {
      quietMs: 100,
      maxWaitMs: 500,
      pollMs: 50,
      now: () => now,
      sleep,
    });
    expect(settled).toBe(true);
    expect(now).toBe(200);
  });

  it('fails open at the bounded deadline when no PTY output arrives', async () => {
    let now = 0;
    const settled = await waitForTerminalOutputSettled(() => null, {
      quietMs: 100,
      maxWaitMs: 250,
      pollMs: 50,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(settled).toBe(false);
    expect(now).toBe(250);
  });
});

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
      '--show-startup-tips',
      'false',
      '--show-release-notes',
      'false',
      '--default-mode',
      'locked',
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
      '--show-startup-tips',
      'false',
      '--show-release-notes',
      'false',
      '--default-mode',
      'locked',
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

  it('tears down when the daemon never accepts the replacement connection', () => {
    // Models a socket that flaps back to transport-connected but never
    // completes an authenticated namespace handshake: onReconnect is never
    // invoked, so the window still fires.
    let bridgeHealthy = false;
    const onGraceElapsed = vi.fn();
    const grace = createReconnectGrace({
      graceMs: 30_000,
      isConnected: () => bridgeHealthy,
      onGraceElapsed,
    });

    grace.onDisconnect();
    // Transport blips but the handshake keeps failing; bridgeHealthy stays
    // false and onReconnect is never called.
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
