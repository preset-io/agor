/**
 * MCP catalog: the checked-in catalog file, the reads over it, and the auth
 * probe the connect flow runs before it installs anything.
 */

export { type AuthProbeOptions, probeRemoteAuthType } from './auth-probe';
export {
  type CatalogPage,
  findCatalogEntry,
  loadCatalog,
  queryCatalog,
} from './catalog';
export {
  CuratedCatalogError,
  curatedCatalogPath,
  loadCuratedCatalog,
  parseCuratedCatalog,
} from './curated-loader';
