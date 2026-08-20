/**
 * Utilities for MCP auth fields that may carry sensitive material.
 *
 * Keep the field list centralized so API response redaction and edit-form
 * sentinel restoration cannot drift.
 */

import {
  isUserEnvPlaceholder,
  TEMPLATE_RESOLVABLE_MCP_AUTH_SECRET_FIELDS,
} from '../../mcp/template-resolver';
import type { MCPAuth } from '../../types/mcp';
import { MCP_HEADER_REDACTED_SENTINEL } from './http-headers';

export const MCP_AUTH_SECRET_FIELDS = [
  'token',
  'api_token',
  'api_secret',
  'oauth_client_secret',
  'oauth_access_token',
  'oauth_refresh_token',
] as const satisfies readonly (keyof MCPAuth)[];

export function redactMCPAuthSecrets(auth?: MCPAuth): MCPAuth | undefined {
  if (!auth) return undefined;

  let changed = false;
  const redacted: MCPAuth = { ...auth };
  const record = redacted as unknown as Record<string, unknown>;

  const templateResolvable = new Set<string>(TEMPLATE_RESOLVABLE_MCP_AUTH_SECRET_FIELDS);

  for (const field of MCP_AUTH_SECRET_FIELDS) {
    const value = redacted[field];
    if (value === undefined) continue;

    // Leave a bare `{{ user.env.NAME }}` placeholder intact ONLY in fields the
    // resolver actually substitutes: downstream session-scoping resolves it
    // against the user's env, and the sentinel would defeat that substitution
    // (yielding a literal `Bearer ••••••••` header the MCP client rejects). The
    // strict placeholder check keeps raw secrets redacted even when wrapped in a
    // single Handlebars expression (`{{secret}}` or a helper/fallback like
    // `{{default user.env.X "sk-live-…"}}`), and fields the resolver never touch
    // — the OAuth runtime secrets `oauth_access_token` / `oauth_refresh_token` —
    // are always redacted.
    if (templateResolvable.has(field) && typeof value === 'string' && isUserEnvPlaceholder(value)) {
      continue;
    }

    record[field] = MCP_HEADER_REDACTED_SENTINEL;
    changed = true;
  }

  return changed ? redacted : auth;
}

/**
 * INVARIANT: the sentinel is never persisted. See the long-form rationale on
 * `restoreRedactedMCPEnvSecrets` — a submitted sentinel is a claim of
 * "unchanged", never a value, so when there is nothing stored to restore (a
 * stale form whose token a concurrent edit or an OAuth disconnect cleared)
 * the field is dropped rather than written. Storing it would leave the server
 * authenticating with a literal `••••••••`.
 */
export function restoreRedactedMCPAuthSecrets(options: {
  current?: MCPAuth;
  next?: MCPAuth;
}): MCPAuth | undefined {
  if (!options.next) return undefined;

  const restored: MCPAuth = { ...options.next };
  const record = restored as unknown as Record<string, unknown>;

  for (const field of MCP_AUTH_SECRET_FIELDS) {
    if (restored[field] !== MCP_HEADER_REDACTED_SENTINEL) continue;

    const stored = options.current?.[field];
    if (stored !== undefined) {
      record[field] = stored;
    } else {
      delete record[field];
    }
  }

  return restored;
}

/**
 * Merge a partial `auth` update onto the stored config for a persisted update.
 *
 * The stored update path is PATCH, not PUT: a caller widening one sub-field
 * (say `oauth_scope`) must not silently clear the others. Widening scope on a
 * Google Calendar connector used to wipe `oauth_compatibility_mode`, the
 * pre-registered `oauth_client_id`, and the client secret, because the whole
 * `auth` object was replaced by whatever the caller sent (see issue #2500). So:
 *
 * - An **omitted** field keeps its stored value.
 * - An **explicit `null`** clears that one field — the escape hatch for unsetting
 *   a previously-set value without resending the rest.
 * - A **redaction sentinel** in a secret field is a claim of "unchanged": the
 *   stored secret is preserved and the sentinel is never persisted (see the
 *   INVARIANT on {@link restoreRedactedMCPAuthSecrets}).
 * - A **new value** overwrites.
 *
 * Merging is scoped to a single auth *mode*. Changing `type` (e.g. `oauth` →
 * `none`, or `oauth` → `bearer`) makes the previous mode's fields meaningless,
 * so a mode switch is a full replace — stale fields from the old mode never
 * survive. An omitted or `null` `next` clears auth entirely.
 */
export function mergeMCPAuth(options: {
  current?: MCPAuth;
  next?: MCPAuth | null;
}): MCPAuth | undefined {
  if (options.next === null || options.next === undefined) return undefined;

  const next = options.next as unknown as Record<string, unknown>;

  // Only merge within one mode. On a mode switch (or when there is no stored
  // auth) start from an empty base so the incoming object fully replaces it.
  const sameType = options.current !== undefined && next.type === options.current.type;
  const merged: Record<string, unknown> = sameType
    ? { ...(options.current as unknown as Record<string, unknown>) }
    : {};

  const secretFields = new Set<string>(MCP_AUTH_SECRET_FIELDS);

  for (const key of Object.keys(next)) {
    const value = next[key];
    // Present-but-undefined is treated as omission: keep the stored value.
    if (value === undefined) continue;
    // Explicit null clears exactly this field; omission would have kept it.
    if (value === null) {
      delete merged[key];
      continue;
    }
    // A sentinel means "unchanged": keep the stored secret already carried in
    // `merged` (same-mode merge), or drop it when there is nothing stored to
    // restore (mode switch, or a stale form after a concurrent edit). The
    // sentinel itself must never be persisted.
    if (secretFields.has(key) && value === MCP_HEADER_REDACTED_SENTINEL) continue;
    merged[key] = value;
  }

  return merged as unknown as MCPAuth;
}
