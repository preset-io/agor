export type OpenCodeModelStatus = 'alpha' | 'beta' | 'deprecated' | 'active';

export interface OpenCodeModelPair {
  providerId: string;
  modelId: string;
}

export interface OpenCodeCatalogModel {
  id: string;
  name: string;
  status: OpenCodeModelStatus;
}

export interface OpenCodeCatalogProvider {
  id: string;
  name: string;
  runtimeAvailable: boolean;
  suggestedModel?: string;
  models: OpenCodeCatalogModel[];
}

/**
 * Secret-safe configured model catalog returned by the protected daemon
 * adapter. Raw OpenCode provider objects never cross this boundary.
 */
export interface OpenCodeModelCatalog {
  runtimeVersion: string;
  projectConfigured?: OpenCodeModelPair;
  /**
   * Safe empty-state suggestion. Prefers the first configured provider, then
   * the first other runtime-available provider, whose active native default is
   * in this catalog. It is advisory; execution still requires a stored pair.
   */
  suggestedSelection?: OpenCodeModelPair;
  providers: OpenCodeCatalogProvider[];
}
