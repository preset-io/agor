/**
 * Server-owned identity attached to the Feathers connection object for one
 * live Socket.IO transport.
 *
 * Socket.IO's `socket.id` is not copied onto `params.connection`: Feathers
 * intentionally exposes `socket.feathers` there. This non-enumerable,
 * immutable property is the bridge between those two server-owned objects.
 * It is never read from request data, query parameters, headers, or the
 * handshake auth payload.
 */
export const AGOR_SOCKET_AUTHORITY_ID_PROPERTY = '__agor_socket_authority_id__' as const;
/** Daemon-internal lifecycle signal; never transported to Socket.IO clients. */
export const AGOR_SOCKET_AUTHORITY_DISCONNECTED_EVENT =
  'agor:socket-authority-disconnected' as const;

type SocketAuthorityConnection = Record<PropertyKey, unknown>;

export function installSocketAuthorityId(
  connection: SocketAuthorityConnection,
  socketId: string
): void {
  if (!socketId) throw new Error('Cannot bind an empty Socket.IO authority identifier');
  const existing = Object.getOwnPropertyDescriptor(connection, AGOR_SOCKET_AUTHORITY_ID_PROPERTY);
  if (existing) {
    if (
      existing.value !== socketId ||
      existing.enumerable ||
      existing.configurable ||
      existing.writable
    ) {
      throw new Error('Socket.IO authority identifier was replaced or weakened');
    }
    return;
  }
  Object.defineProperty(connection, AGOR_SOCKET_AUTHORITY_ID_PROPERTY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: socketId,
  });
}

export function readSocketAuthorityId(connection: unknown): string | undefined {
  if (!connection || typeof connection !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(connection, AGOR_SOCKET_AUTHORITY_ID_PROPERTY);
  if (
    !descriptor ||
    descriptor.enumerable ||
    descriptor.configurable ||
    descriptor.writable ||
    typeof descriptor.value !== 'string' ||
    !descriptor.value
  ) {
    return undefined;
  }
  return descriptor.value;
}
