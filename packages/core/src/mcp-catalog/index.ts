/**
 * MCP catalog: the checked-in catalog file, the reads over it, and the auth
 * probe the connect flow runs before it installs anything.
 */

export {
  type AuthProbeOptions,
  type MCPApiKeyProbeVerdict,
  probeRemoteApiKey,
  probeRemoteAuth,
  probeRemoteAuthType,
  probeRemoteBearerToken,
  type RemoteAuthProbeResult,
} from './auth-probe';
export { findCatalogEntry, loadCatalog } from './catalog';
export { CuratedCatalogError, loadCuratedCatalog } from './curated-loader';
export {
  auditCatalogHealth,
  type CatalogHealthAuditDependencies,
  type CatalogHealthReason,
  type CatalogHealthResult,
  type CatalogHealthStatus,
} from './health-audit';
// Also reachable as `@agor/core/mcp-catalog/query`, which is the import the
// browser bundle uses: this barrel pulls in the loader, and the loader reads
// the file off disk.
export { filterCatalog } from './query';
