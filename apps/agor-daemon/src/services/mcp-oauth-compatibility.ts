import { findCatalogEntry, loadCatalog } from '@agor/core/mcp-catalog';
import type {
  MCPCatalogEntry,
  MCPOAuthRuntimeCompatibilityMode,
  MCPServer,
} from '@agor/core/types';
import { assertPublicMCPOAuthCompatibilityMode } from '@agor/core/types';
import { catalogOAuthConfig, isCurrentCatalogInstall } from './mcp-catalog-install-policy.js';

export type MCPOAuthCompatibilityPolicyReason =
  | 'explicit_strict'
  | 'explicit_legacy'
  | 'current_catalog_strict'
  | 'current_catalog_marketplace'
  | 'catalog_entry_removed'
  | 'catalog_configuration_drift'
  | 'general_default_strict';

export interface MCPOAuthCompatibilityPolicy {
  mode: MCPOAuthRuntimeCompatibilityMode;
  reason: MCPOAuthCompatibilityPolicyReason;
  catalogEntryName?: string;
}

/** Public, non-persisted projection used by Settings to show effective policy. */
export function presentMCPOAuthCompatibilityPolicy(
  policy: MCPOAuthCompatibilityPolicy
): NonNullable<MCPServer['oauth_compatibility_policy']> {
  return {
    effective_mode: policy.mode,
    managed_by_catalog:
      policy.reason === 'current_catalog_marketplace' || policy.reason === 'current_catalog_strict',
  };
}

/**
 * Resolve one saved server against the CURRENT curated catalog.
 *
 * Public/persisted input is validated before any derivation. An explicit
 * strict/legacy choice remains authoritative. Omission can become marketplace
 * only when the durable row is still a canonical install of a current OAuth
 * entry; a historical stamp, removed entry, edited endpoint/auth/header, or
 * imported row falls back to strict.
 */
export async function resolveMCPOAuthCompatibilityPolicy(
  server: Pick<
    MCPServer,
    'source' | 'catalog_entry_name' | 'transport' | 'url' | 'auth' | 'headers'
  >,
  catalogEntries?: readonly MCPCatalogEntry[]
): Promise<MCPOAuthCompatibilityPolicy> {
  assertPublicMCPOAuthCompatibilityMode(server.auth);
  const configured = server.auth?.oauth_compatibility_mode;
  if (configured) {
    return {
      mode: configured,
      reason: configured === 'strict' ? 'explicit_strict' : 'explicit_legacy',
      ...(server.catalog_entry_name ? { catalogEntryName: server.catalog_entry_name } : {}),
    };
  }

  if (server.source !== 'catalog' || !server.catalog_entry_name) {
    return { mode: 'strict', reason: 'general_default_strict' };
  }

  const entries = catalogEntries ?? (await loadCatalog());
  const entry = findCatalogEntry(entries, server.catalog_entry_name);
  if (!entry?.remote_url || entry.auth_type !== 'oauth') {
    return {
      mode: 'strict',
      reason: 'catalog_entry_removed',
      catalogEntryName: server.catalog_entry_name,
    };
  }

  if (
    !isCurrentCatalogInstall(
      server,
      entry as MCPCatalogEntry & { remote_url: string },
      catalogOAuthConfig(entry),
      {
        reconcileMissingCompatibilityMode: true,
      }
    )
  ) {
    return {
      mode: 'strict',
      reason: 'catalog_configuration_drift',
      catalogEntryName: server.catalog_entry_name,
    };
  }

  const mode = entry.oauth?.compatibility_mode ?? 'marketplace';
  return {
    mode,
    reason: mode === 'strict' ? 'current_catalog_strict' : 'current_catalog_marketplace',
    catalogEntryName: entry.name,
  };
}

/** Secret-free, stable policy evidence at the flow boundary. */
export function logMCPOAuthCompatibilityPolicy(
  operation: string,
  serverId: string | undefined,
  policy: MCPOAuthCompatibilityPolicy
): void {
  console.info(
    `[MCP OAuth] compatibility operation=${operation} mode=${policy.mode} reason=${policy.reason} ` +
      `server=${serverId ?? '<unsaved>'} catalog_entry=${policy.catalogEntryName ?? '<none>'}`
  );
}
