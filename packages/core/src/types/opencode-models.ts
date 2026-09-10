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

import type { OpenCodeUnsupportedReason } from './opencode-auth';

/** Secret-safe, versioned choices returned without starting an OpenCode server. */
export interface OpenCodeModelCatalog {
  runtimeVersion: string;
  suggestedSelection?: OpenCodeModelPair;
  providers: OpenCodeCatalogProvider[];
  /** Present when this deployment cannot run OpenCode; every provider is then unavailable. */
  unsupported?: OpenCodeUnsupportedReason;
}
