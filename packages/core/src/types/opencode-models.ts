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
