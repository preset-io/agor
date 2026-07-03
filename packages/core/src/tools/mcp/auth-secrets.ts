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

export function restoreRedactedMCPAuthSecrets(options: {
  current?: MCPAuth;
  next?: MCPAuth;
}): MCPAuth | undefined {
  if (!options.next) return undefined;

  const restored: MCPAuth = { ...options.next };
  const record = restored as unknown as Record<string, unknown>;

  for (const field of MCP_AUTH_SECRET_FIELDS) {
    if (
      restored[field] === MCP_HEADER_REDACTED_SENTINEL &&
      options.current?.[field] !== undefined
    ) {
      record[field] = options.current[field];
    }
  }

  return restored;
}
