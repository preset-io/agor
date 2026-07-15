import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReconnectGrace, waitForZellijReady } from './zellij.js';

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
