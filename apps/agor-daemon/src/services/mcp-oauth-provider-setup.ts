import { findCatalogEntry, loadCatalog } from '@agor/core/mcp-catalog';
import type { MCPAuthRecovery, MCPCatalogEntry, MCPServer } from '@agor/core/types';
import { catalogServerTransport, sameCatalogEndpoint } from './mcp-catalog-install-policy.js';

/**
 * Restrictive policy only; never grants compatibility or credential authority.
 * Call with a row already authorized and loaded in the caller's tenant scope.
 * Existing grants are unaffected. A deliberately configured client bypasses
 * automatic registration, but still faces the unchanged strict OAuth checks.
 */
export async function catalogOAuthSetupRecovery(
  server: MCPServer,
  catalogEntries?: readonly MCPCatalogEntry[]
): Promise<MCPAuthRecovery | undefined> {
  if (
    server.source !== 'catalog' ||
    !server.catalog_entry_name ||
    server.auth?.type !== 'oauth' ||
    server.auth.oauth_client_id
  )
    return undefined;
  const entry = findCatalogEntry(
    catalogEntries ?? (await loadCatalog()),
    server.catalog_entry_name
  );
  if (
    !entry?.setup_required ||
    !entry.remote_url ||
    server.transport !== catalogServerTransport(entry) ||
    !sameCatalogEndpoint(server.url, entry.remote_url)
  )
    return undefined;
  return {
    category: 'configuration_required',
    action: 'contact_admin',
    message: entry.setup_required.message,
    mcp_server_id: server.mcp_server_id,
  };
}
