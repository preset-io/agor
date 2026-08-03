import { OpenCodeModelSelector } from './OpenCodeModelSelector.js';
import { OpenCodeProviderSettings } from './OpenCodeProviderSettings.js';

export {
  type OpenCodeModelConfig,
  OpenCodeModelSelector,
  type OpenCodeModelSelectorProps,
} from './OpenCodeModelSelector.js';
export { OpenCodeProviderSettings } from './OpenCodeProviderSettings.js';

export const OPENCODE_UI_CONTRIBUTION = {
  name: 'opencode',
  agentSelectionOption: {
    icon: '🌐',
    description: 'Open-source terminal AI with 75+ LLM providers',
  },
  onboardingOption: {
    symbol: '⚙',
    title: 'Multiple providers',
    description: 'Connect a native OpenCode provider and choose its exact model',
  },
  modelLabel: 'OpenCode LLM Provider',
  ModelSelector: OpenCodeModelSelector,
  ProviderSettings: OpenCodeProviderSettings,
  permissionModes: [
    {
      mode: 'default',
      label: 'Manual',
      description: 'Asks before each operation · for high-stakes changes',
      icon: 'lock',
      tone: 'danger',
    },
    {
      mode: 'autoEdit',
      label: 'Accept edits',
      description: 'Auto-approves edits, asks for other operations · recommended for OpenCode',
      icon: 'edit',
      tone: 'success',
    },
    {
      mode: 'yolo',
      label: 'Bypass permissions',
      description: 'Fully bypasses permission checks · isolated environments only',
      icon: 'unlock',
      tone: 'warning',
    },
  ],
} as const;
