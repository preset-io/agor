import type { TerminalAllocatedEvent } from '@agor/core/types';

/**
 * Server-only capability attached to a Feathers Socket.IO connection.
 *
 * The terminals service creates an unpredictable, tenant-qualified room and
 * must subscribe the authenticated requesting socket before it starts an
 * executor. Keeping the callback on the transport-owned connection object
 * avoids exposing a client-controlled room name or coupling the service to the
 * Socket.IO server implementation.
 */
export const TERMINAL_REQUEST_JOIN_CHANNEL = Symbol('agor.terminal-request-join-channel');

export interface TerminalRequestConnection {
  [TERMINAL_REQUEST_JOIN_CHANNEL]?: (
    channel: string,
    allocation: TerminalAllocatedEvent
  ) => Promise<boolean>;
}
