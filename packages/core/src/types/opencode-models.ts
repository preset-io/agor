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
  /**
   * The known provider is selectable without credentials or Agor found saved
   * credential evidence. Task execution remains the authoritative check.
   */
  runtimeAvailable: boolean;
  suggestedModel?: string;
  models: OpenCodeCatalogModel[];
}

/**
 * Secret-safe curated model catalog returned by the protected daemon adapter.
 * Raw OpenCode provider objects and credentials never cross this boundary.
 */
export interface OpenCodeModelCatalog {
  runtimeVersion: string;
  /**
   * Safe empty-state suggestion. Prefers the first known provider with saved
   * credentials, then the first known provider available without credentials.
   * It is advisory; execution still requires and validates a stored pair.
   */
  suggestedSelection?: OpenCodeModelPair;
  providers: OpenCodeCatalogProvider[];
}
