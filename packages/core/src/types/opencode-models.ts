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
  providers: OpenCodeCatalogProvider[];
}
