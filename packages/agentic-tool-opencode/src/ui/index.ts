import { OpenCodeModelSelector } from './OpenCodeModelSelector.js';

export {
  type OpenCodeModelConfig,
  OpenCodeModelSelector,
  type OpenCodeModelSelectorProps,
} from './OpenCodeModelSelector.js';

export const OPENCODE_UI_CONTRIBUTION = Object.freeze({
  name: 'opencode',
  agentSelectionOption: {
    icon: '🌐',
    description: 'Open-source terminal AI with 75+ LLM providers',
    beta: true,
  },
  onboardingOption: {
    symbol: '⚙',
    title: 'Custom',
    description: 'Use any model with an OpenAI-compatible API endpoint',
  },
  modelLabel: 'OpenCode LLM Provider',
  ModelSelector: OpenCodeModelSelector,
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
      label: 'Auto',
      description: 'Auto-approves all operations · recommended for OpenCode',
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
} as const);
