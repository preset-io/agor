/** socket.io-client rejects an acknowledgement it already sent with these, so the server may have acted. */
export const SOCKET_DISCONNECTED_ERROR = 'socket has been disconnected';
export const SOCKET_ACK_TIMEOUT_ERROR = 'operation has timed out';

/** Thrown by the UI itself before any request when an action starts without a live client. */
export const CLIENT_NOT_CONNECTED_ERROR = 'Client not connected';

const IN_FLIGHT_CONNECTION_LOSS_MESSAGES: ReadonlySet<string> = new Set([
  SOCKET_DISCONNECTED_ERROR,
  SOCKET_ACK_TIMEOUT_ERROR,
]);

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
}

/** The request may have reached Agor before the connection dropped, so its outcome is unknown. */
export function isInFlightConnectionLossError(error: unknown): boolean {
  return IN_FLIGHT_CONNECTION_LOSS_MESSAGES.has(errorMessage(error));
}

/** The action failed because there was no connection, so nothing was sent. */
function isNotConnectedError(error: unknown): boolean {
  return errorMessage(error) === CLIENT_NOT_CONNECTED_ERROR;
}

/** Appends the raw error in brackets so technical readers (and Copy) still see it. */
export function withConnectionErrorDetail(message: string, error: unknown): string {
  return `${message} (${errorMessage(error)})`;
}

/** Toast copy for a failed action phrase; creates pass `idempotent: false` because a retry after a lost reply can do them twice. */
export function formatActionError(
  action: string,
  error: unknown,
  { idempotent }: { idempotent: boolean }
): string {
  if (isNotConnectedError(error)) {
    return withConnectionErrorDetail(
      `Couldn't ${action}. The connection to Agor dropped. Try again once it's back.`,
      error
    );
  }
  if (isInFlightConnectionLossError(error)) {
    return withConnectionErrorDetail(
      idempotent
        ? `The connection to Agor dropped before this was confirmed. If it didn't go through, try to ${action} again once the connection is back.`
        : `The connection to Agor dropped before this was confirmed. Refresh to see if it went through before you try to ${action} again.`,
      error
    );
  }
  return `Failed to ${action}: ${errorMessage(error)}`;
}
