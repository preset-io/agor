/**
 * Utilities for MCP server `env` values, which are secret-bearing.
 *
 * `env` is where a stdio MCP server's credentials live (`GITHUB_TOKEN`,
 * `DATADOG_API_KEY`, …), so it needs the same redact-on-read /
 * restore-on-write treatment `headers` and `auth` already have.
 *
 * Deliberately NOT reusing `normalizeMCPCustomHeaders`: that normalizer
 * enforces HTTP token syntax on the key and drops reserved header names, and
 * several of those names — `HOST`, `CONNECTION`, `UPGRADE`, `TE` — are
 * perfectly ordinary environment variables. Routing `env` through it would
 * silently delete them on every read.
 */

import { isUserEnvPlaceholder } from '../../mcp/template-patterns';
import { MCP_HEADER_REDACTED_SENTINEL } from './http-headers';

/**
 * Replace every `env` value with the redaction sentinel.
 *
 * Keys are preserved so a caller can still see *which* variables a server is
 * configured with, and so the UI can distinguish "unset" from "set but
 * hidden" — an empty/absent `env` still renders as empty, a configured one
 * renders as `{"GITHUB_TOKEN": "••••••••"}`.
 *
 * A bare `{{ user.env.NAME }}` placeholder is left intact, matching
 * `redactMCPCustomHeaders`: it names a variable rather than carrying its
 * value, it is the more useful thing to show in the edit form, and replacing
 * it with the sentinel would turn a resolvable reference into a literal.
 * Partial, multiple, and helper expressions can still carry secret material
 * and are redacted.
 */
export function redactMCPEnvSecrets(
  env?: Record<string, string>
): Record<string, string> | undefined {
  if (!env) return undefined;

  const entries = Object.entries(env);
  if (entries.length === 0) return env;

  let changed = false;
  const redacted: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value === 'string' && isUserEnvPlaceholder(value)) {
      redacted[key] = value;
      continue;
    }
    redacted[key] = MCP_HEADER_REDACTED_SENTINEL;
    changed = true;
  }

  return changed ? redacted : env;
}

/**
 * Put the stored value back wherever an edit form submitted the sentinel
 * unchanged. Without this, saving any unrelated field on a server would
 * overwrite every secret with `••••••••`.
 *
 * A key absent from `next` is a deletion and stays deleted; a key whose value
 * differs from the sentinel is a genuine edit and is taken as submitted.
 *
 * INVARIANT: the sentinel is never persisted. It is in-band signalling — it
 * travels in the same channel as real values — so a submitted sentinel is
 * only ever a claim of "unchanged", never a value. If there is nothing stored
 * to restore, the claim refers to something that no longer exists (a stale
 * form whose variable was deleted by a concurrent edit), and the key is
 * dropped rather than written. Writing it would resurrect the variable
 * holding `••••••••`, and every executor would then launch with a credential
 * that is silently bogus.
 *
 * The cost is that a value which genuinely equals the sentinel cannot be set;
 * it is indistinguishable from an unchanged field by construction. Eight
 * bullet characters is not a credential anyone has, and the alternative —
 * refusing every submitted sentinel — would break the ordinary round-trip
 * this function exists to support.
 */
export function restoreRedactedMCPEnvSecrets(options: {
  current?: Record<string, string>;
  next?: Record<string, string>;
}): Record<string, string> | undefined {
  if (!options.next) return undefined;

  const restored: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.next)) {
    if (value === MCP_HEADER_REDACTED_SENTINEL) {
      const stored = options.current?.[key];
      if (stored !== undefined) restored[key] = stored;
      continue;
    }
    restored[key] = value;
  }

  return restored;
}
