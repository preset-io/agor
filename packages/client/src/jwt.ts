/**
 * Browser-safe JWT decode helpers — thin re-export of `@agor/core/utils/jwt`.
 *
 * Exposed on `@agor-live/client` so UI/browser consumers can decode JWT
 * `exp` claims (e.g. for proactive refresh) without taking a direct dep on
 * `@agor/core`. Same implementation the daemon-side `resolveTokenExpiry`
 * cascade uses, so behavior never drifts between server and client.
 *
 * No signature verification — we read our own tokens to learn when WE think
 * they expire. The server is still the only party that validates.
 */

export * from '@agor/core/utils/jwt';
