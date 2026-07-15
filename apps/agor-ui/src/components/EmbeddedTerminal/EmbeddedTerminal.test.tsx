import type { AgorClient } from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// xterm touches canvas/DOM internals that jsdom can't render; the component's
// reconnect/ready plumbing doesn't depend on real terminal output, so stub it.
// The class lives inside the factory because vi.mock is hoisted above imports.
vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    rows = 24;
    cols = 80;
    _core = { _renderService: { dimensions: { css: { cell: { width: 0, height: 0 } } } } };
    open() {}
    loadAddon() {}
    onRender() {
      return { dispose() {} };
    }
    onData() {}
    onResize() {}
    resize() {}
    write() {}
    writeln() {}
    clear() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { EmbeddedTerminal } from './EmbeddedTerminal';

const ALICE = '11111111-aaaa-aaaa-aaaa-111111111111';

interface FakeSocket {
  connected: boolean;
  emitted: Array<{ event: string; data: unknown }>;
  on(event: string, fn: (...args: unknown[]) => void): void;
  off(event: string, fn: (...args: unknown[]) => void): void;
  emit(event: string, data?: unknown): void;
  trigger(event: string, data?: unknown): void;
}

function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    connected: true,
    emitted: [],
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(fn);
    },
    off(event, fn) {
      handlers.get(event)?.delete(fn);
    },
    emit(event, data) {
      this.emitted.push({ event, data });
    },
    trigger(event, data) {
      for (const fn of handlers.get(event) ?? []) fn(data);
    },
  };
}

function makeClient(socket: FakeSocket, create: ReturnType<typeof vi.fn>) {
  return {
    io: socket,
    service: vi.fn(() => ({ create })),
  } as unknown as AgorClient;
}

describe('EmbeddedTerminal reconnect + readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays "connecting" until the ready ack, then connects', async () => {
    const socket = makeFakeSocket();
    const create = vi.fn().mockResolvedValue({
      userId: ALICE,
      channel: `user/${ALICE}/terminal`,
      sessionName: 'agor-x',
      isNew: true,
      ready: false,
    });
    render(<EmbeddedTerminal client={makeClient(socket, create)} userId={ALICE} />);

    // Cold start: create resolved but no ready ack yet → still connecting.
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Connecting to terminal/)).toBeInTheDocument();
    // It joined the channel to receive output.
    expect(socket.emitted.some((e) => e.event === 'join')).toBe(true);

    // Executor acks readiness → connected, indicator clears.
    socket.trigger('terminal:ready', { userId: ALICE });
    await waitFor(() =>
      expect(screen.queryByText(/Connecting to terminal/)).not.toBeInTheDocument()
    );
  });

  it('shows reconnecting and re-issues create + join when the socket reconnects', async () => {
    const socket = makeFakeSocket();
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        userId: ALICE,
        channel: `user/${ALICE}/terminal`,
        sessionName: 'agor-x',
        isNew: true,
        ready: false,
      })
      // Warm path on reconnect: executor still alive.
      .mockResolvedValue({
        userId: ALICE,
        channel: `user/${ALICE}/terminal`,
        sessionName: 'agor-x',
        isNew: false,
        ready: true,
      });
    render(<EmbeddedTerminal client={makeClient(socket, create)} userId={ALICE} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    socket.trigger('terminal:ready', { userId: ALICE });

    // A blip drops the socket.
    socket.connected = false;
    socket.trigger('disconnect', 'transport close');
    expect(await screen.findByText(/Reconnecting/)).toBeInTheDocument();

    // Transport restored → re-attach (re-create + re-join) and connect via the
    // warm ready flag.
    const joinsBefore = socket.emitted.filter((e) => e.event === 'join').length;
    socket.connected = true;
    socket.trigger('connect');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(socket.emitted.filter((e) => e.event === 'join').length).toBeGreaterThan(joinsBefore)
    );
    await waitFor(() => expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument());
  });
});
