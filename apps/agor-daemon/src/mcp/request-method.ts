/** Bounded protocol labels, not client-provided method strings or request IDs. */
const REQUEST_METHODS = new Set([
  'initialize',
  'ping',
  'server/discover',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'notifications/initialized',
  'notifications/cancelled',
]);

export function requestMethod(body: unknown): string {
  if (Array.isArray(body)) return 'batch';
  const method = body && typeof body === 'object' ? (body as { method?: unknown }).method : null;
  return typeof method === 'string' && REQUEST_METHODS.has(method) ? method : 'other';
}
