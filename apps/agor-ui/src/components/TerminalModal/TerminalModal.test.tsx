import type { AgorClient, User } from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// xterm touches canvas/DOM internals jsdom can't render; the modal's
// reconnect/ready plumbing doesn't depend on real terminal output.
vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    rows = 40;
    cols = 160;
    open() {}
    loadAddon() {}
    onData() {}
    onResize() {}
    write() {}
    writeln() {}
    clear() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { TerminalModal } from './TerminalModal';

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

const memberUser = { user_id: ALICE, role: 'member' } as unknown as User;
// Stable reference: the modal effect depends on `initialCommands`, so a fresh
// array each render would thrash the effect (tear down + re-attach) and reset
// transient state under test.
const NO_COMMANDS: string[] = [];

describe('TerminalModal reconnect + readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects on the ready ack and re-attaches on reconnect', async () => {
    const socket = makeFakeSocket();
    const create = vi.fn().mockResolvedValue({
      userId: ALICE,
      channel: `user/${ALICE}/terminal`,
      sessionName: 'agor-x',
      isNew: true,
      ready: false,
    });
    render(
      <TerminalModal
        open
        onClose={() => {}}
        client={makeClient(socket, create)}
        user={memberUser}
        initialCommands={NO_COMMANDS}
      />
    );

    // Effect is gated on the modal's afterOpenChange; wait for the first attach.
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    // Cold path: not connected until the executor acks readiness.
    socket.trigger('terminal:ready', { userId: ALICE });

    // A blip drops the socket → reconnecting; reconnect re-issues create.
    socket.connected = false;
    socket.trigger('disconnect', 'transport close');
    expect(await screen.findByText(/Reconnecting/)).toBeInTheDocument();

    socket.connected = true;
    socket.trigger('connect');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });

  it('ignores a stale attach that resolves after a disconnect/reconnect', async () => {
    const socket = makeFakeSocket();
    const deferreds: Array<(v: unknown) => void> = [];
    const create = vi.fn(
      () =>
        new Promise((resolve) => {
          deferreds.push(resolve);
        })
    );
    render(
      <TerminalModal
        open
        onClose={() => {}}
        client={makeClient(socket, create)}
        user={memberUser}
        initialCommands={NO_COMMANDS}
      />
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    socket.connected = false;
    socket.trigger('disconnect', 'transport close');
    socket.connected = true;
    socket.trigger('connect');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Reconnecting/)).toBeInTheDocument();

    // Stale first attach resolves late → must be dropped (superseded generation).
    deferreds[0]?.({
      userId: ALICE,
      channel: `user/${ALICE}/terminal`,
      sessionName: 'agor-x',
      isNew: true,
      ready: true,
    });
    await Promise.resolve();
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
  });
});
