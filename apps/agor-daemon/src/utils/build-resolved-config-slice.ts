/**
 * Build the daemon-resolved config slice that gets embedded in executor
 * payloads. See `@agor/core/config` for the schema, and
 * `context/explorations/daemon-fs-decoupling.md` §1.5 (H1) for why.
 *
 * Reads via `loadConfigSync()`, which is stat-validated and cached — calling
 * this on every spawn is cheap.
 *
 * Lives in its own file rather than inside `spawn-executor.ts` so that file
 * can stay focused on subprocess / template / sudo / env-routing concerns.
 */

import { loadConfigSync, type ResolvedConfigSlice } from '@agor/core/config';

/**
 * Inject a daemon-resolved config slice into an executor payload if the
 * caller didn't already provide one.
 *
 * Compares `payload.resolvedConfig !== undefined` rather than using
 * `'resolvedConfig' in payload`. A caller passing
 * `{ resolvedConfig: undefined }` should still get the daemon-built slice —
 * `JSON.stringify()` drops `undefined` anyway, so an `in`-based check would
 * silently ship an empty payload and the executor would fall back to
 * handler defaults.
 *
 * Returns a NEW payload object when injection happens, otherwise the
 * original reference unchanged.
 */
export function withResolvedConfig<T extends { resolvedConfig?: unknown }>(payload: T): T {
  if (payload.resolvedConfig !== undefined) {
    return payload;
  }
  return { ...payload, resolvedConfig: buildResolvedConfigSlice() };
}

export function buildResolvedConfigSlice(): ResolvedConfigSlice {
  try {
    const config = loadConfigSync();
    // Build by omitting sections whose values are all undefined, so the
    // in-memory shape matches what survives JSON serialization across
    // stdin to the executor. Tests assert this shape directly, so it must
    // be true on both sides of the wire.
    //
    // `satisfies` makes the daemon-side producer type-check against the
    // same schema the executor uses to parse the payload (both pulled from
    // @agor/core/config). Adding a new field to ResolvedConfigSlice
    // without sourcing it here is a compile error.
    const slice: ResolvedConfigSlice = {};
    const permissionTimeoutMs = config.execution?.permission_timeout_ms;
    if (permissionTimeoutMs !== undefined) {
      slice.execution = { permission_timeout_ms: permissionTimeoutMs };
    }
    const opencodeServerUrl = config.opencode?.serverUrl;
    if (opencodeServerUrl !== undefined) {
      slice.opencode = { serverUrl: opencodeServerUrl };
    }
    const hostIpAddress = config.daemon?.host_ip_address;
    if (hostIpAddress !== undefined) {
      slice.daemon = { host_ip_address: hostIpAddress };
    }
    return slice satisfies ResolvedConfigSlice;
  } catch (error) {
    // Don't fail a spawn over a config read error — handlers have defaults.
    console.warn(
      '[Executor] Failed to resolve config slice; handlers will fall back to defaults:',
      error instanceof Error ? error.message : String(error)
    );
    return {};
  }
}
