/** Stable reasons a deployment cannot run OpenCode; the UI renders them as a permanent notice. */
export type OpenCodeUnsupportedCode =
  | 'hosted_tenancy'
  | 'delegated_execution'
  | 'templated_transport'
  | 'persistent_user_home_required';

export interface OpenCodeUnsupportedReason {
  code: OpenCodeUnsupportedCode;
  message: string;
}

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
  /** True when this configured or credentialless provider may be offered for selection. */
  availableForSelection: boolean;
  suggestedModel?: string;
  models: OpenCodeCatalogModel[];
}

/** Secret-safe, versioned choices returned without starting an OpenCode server. */
export interface OpenCodeModelCatalog {
  runtimeVersion: string;
  suggestedSelection?: OpenCodeModelPair;
  providers: OpenCodeCatalogProvider[];
  /** Present when this deployment cannot run OpenCode; providers is then empty. */
  unsupported?: OpenCodeUnsupportedReason;
}
