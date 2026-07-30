import type { AgorClient } from '@agor/core/client';
import type { AgenticToolName } from '@agor/core/types';
import type { ComponentType } from 'react';
import {
  OpenCodeModelSelector,
  type OpenCodeModelSelectorProps,
  OpenCodeProviderSettings,
} from '../opencode/ui/index.js';

export interface AgenticToolUIIntegration {
  ModelSelector?: ComponentType<OpenCodeModelSelectorProps>;
  ProviderSettings?: ComponentType<{ client: AgorClient }>;
}

const UI_INTEGRATIONS: Partial<Record<AgenticToolName, AgenticToolUIIntegration>> = {
  opencode: {
    ModelSelector: OpenCodeModelSelector,
    ProviderSettings: OpenCodeProviderSettings,
  },
};

export function getAgenticToolUIIntegration(
  tool: AgenticToolName
): AgenticToolUIIntegration | undefined {
  return UI_INTEGRATIONS[tool];
}

export * from '../opencode/ui/index.js';
