/**
 * MCP catalog: registry mirror, curated overlay, and the auth probe that tells
 * the marketplace which connect branch to render.
 */

export { type AuthProbeOptions, probeRemoteAuthType } from './auth-probe';
export {
  type CuratedCatalogEntry,
  CuratedCatalogError,
  curatedCatalogPath,
  loadCuratedCatalog,
  parseCuratedCatalog,
} from './curated-loader';
export {
  type IngestionOptions,
  type IngestionResult,
  runCatalogIngestion,
  type WithCatalogRepository,
} from './ingestion';
export {
  DEFAULT_MCP_REGISTRY_URL,
  MCPRegistryClient,
  normalizeRegistryServer,
  type RegistryClientOptions,
  type RegistryFetchPage,
} from './registry-client';
export {
  type SeedCuratedCatalogOptions,
  type SeedCuratedCatalogResult,
  seedCuratedCatalog,
} from './seed';
