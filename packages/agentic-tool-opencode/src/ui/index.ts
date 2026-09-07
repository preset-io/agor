import { OpenCodeModelSelector } from './OpenCodeModelSelector.js';
import { OpenCodeProviderSettings } from './OpenCodeProviderSettings.js';
import { OpenCodeReadiness } from './OpenCodeReadiness.js';

export {
  type OpenCodeModelConfig,
  OpenCodeModelSelector,
  type OpenCodeModelSelectorProps,
} from './OpenCodeModelSelector.js';
export { OpenCodeProviderSettings } from './OpenCodeProviderSettings.js';
export { OpenCodeReadiness } from './OpenCodeReadiness.js';
export { useOpenCodeReasoningEffortLevels } from './useOpenCodeReasoningEffortLevels.js';

export const OPENCODE_UI_CONTRIBUTION = {
  name: 'opencode',
  agentSelectionOption: {
    icon: '🌐',
    description: 'Open-source terminal AI with 75+ LLM providers',
  },
  onboardingOption: {
    symbol: '⚙',
    title: 'Custom',
    description: 'Use any model with an OpenAI-compatible API endpoint',
  },
  modelLabel: 'OpenCode LLM Provider',
  ModelSelector: OpenCodeModelSelector,
  ProviderSettings: OpenCodeProviderSettings,
  Readiness: OpenCodeReadiness,
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
