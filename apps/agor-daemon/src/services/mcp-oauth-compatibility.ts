import type { MCPAuth, MCPOAuthRuntimeCompatibilityMode, MCPSource } from '@agor/core/types';

/**
 * Resolve the policy the OAuth transport must enforce for one saved server.
 *
 * The public/user-authored configuration surface still has exactly two
 * choices and still defaults to `strict`. `marketplace` is an internal policy
 * selected only by trusted provenance: both the catalog source and protected
 * `catalog_entry_name` stamp must be present. The daemon install path writes
 * that stamp, and request payloads cannot forge it. A catalog entry can retain
 * strict behavior explicitly by stating `compatibility_mode: strict`; legacy
 * remains an explicit, broader escape hatch rather than the marketplace
 * default.
 */
export function resolveMCPOAuthCompatibilityMode(server: {
  source?: MCPSource;
  catalog_entry_name?: string;
  auth?: MCPAuth;
}): MCPOAuthRuntimeCompatibilityMode {
  return (
    server.auth?.oauth_compatibility_mode ??
    (server.source === 'catalog' && server.catalog_entry_name ? 'marketplace' : 'strict')
  );
}
