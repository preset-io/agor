import { describe, expect, it } from 'vitest';
import {
  CLIENT_NOT_CONNECTED_ERROR,
  formatActionError,
  isInFlightConnectionLossError,
  SOCKET_ACK_TIMEOUT_ERROR,
  SOCKET_DISCONNECTED_ERROR,
} from './connectionErrors';

describe('isInFlightConnectionLossError', () => {
  it.each(['socket has been disconnected', 'operation has timed out'])(
    'recognises socket.io-client %j',
    (message) => {
      expect(isInFlightConnectionLossError(new Error(message))).toBe(true);
      expect(isInFlightConnectionLossError(message)).toBe(true);
      expect(isInFlightConnectionLossError({ message })).toBe(true);
    }
  );

  it.each([
    'Session is busy',
    'the socket has been disconnected by the server',
    'Socket Has Been Disconnected',
    CLIENT_NOT_CONNECTED_ERROR,
    '',
  ])('rejects %j', (message) => {
    expect(isInFlightConnectionLossError(new Error(message))).toBe(false);
  });

  it.each([null, undefined, 42])('rejects non-error value %j', (value) => {
    expect(isInFlightConnectionLossError(value)).toBe(false);
  });
});

describe('formatActionError', () => {
  it('advises a retry when nothing was sent', () => {
    for (const idempotent of [true, false]) {
      expect(
        formatActionError('create the board', new Error(CLIENT_NOT_CONNECTED_ERROR), { idempotent })
      ).toBe(
        "Couldn't create the board. The connection to Agor dropped. Try again once it's back. (Client not connected)"
      );
    }
  });

  it('suggests a retry after an in-flight loss only when repeating is harmless', () => {
    expect(
      formatActionError('archive the branch', new Error(SOCKET_DISCONNECTED_ERROR), {
        idempotent: true,
      })
    ).toBe(
      "The connection to Agor dropped before this was confirmed. If it didn't go through, try to archive the branch again once the connection is back. (socket has been disconnected)"
    );
  });

  it('asks the user to check before repeating a create whose outcome is unknown', () => {
    expect(
      formatActionError('fork the session', new Error(SOCKET_ACK_TIMEOUT_ERROR), {
        idempotent: false,
      })
    ).toBe(
      'The connection to Agor dropped before this was confirmed. Refresh to see if it went through before you try to fork the session again. (operation has timed out)'
    );
  });

  it('keeps the existing format for other errors', () => {
    expect(
      formatActionError('update the board', new Error('Board name required'), { idempotent: true })
    ).toBe('Failed to update the board: Board name required');
    expect(formatActionError('create the board', 'nope', { idempotent: false })).toBe(
      'Failed to create the board: nope'
    );
  });
});
