/**
 * Identify Socket.IO's namespace handshake object at authentication-strategy
 * parse boundaries. Feathers runs transport header parsing before application
 * Socket.IO middleware; Agor's namespace boundary must own that parsing so all
 * credentials share one normalized, fail-closed handshake path.
 */
export function isSocketIoHandshakeRequest(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.hasOwn(candidate, 'auth') &&
    Object.hasOwn(candidate, 'issued') &&
    Object.hasOwn(candidate, 'query')
  );
}
