import { OpenCodeModelSelector } from './OpenCodeModelSelector.js';
import { OpenCodeProviderSettings } from './OpenCodeProviderSettings.js';

export {
  type OpenCodeModelConfig,
  OpenCodeModelSelector,
  type OpenCodeModelSelectorProps,
} from './OpenCodeModelSelector.js';
export { OpenCodeProviderSettings } from './OpenCodeProviderSettings.js';
export { useOpenCodeModelCatalog } from './useOpenCodeModelCatalog.js';

export const OPENCODE_UI_CONTRIBUTION = {
  name: 'opencode',
  ModelSelector: OpenCodeModelSelector,
  ProviderSettings: OpenCodeProviderSettings,
} as const;
