import { OPENCODE_UI_CONTRIBUTION } from '@agor/agentic-tool-opencode/ui';
import type { AgorClient } from '@agor/core/client';
import type { AgenticToolName } from '@agor/core/types';
import type { ComponentType } from 'react';

export interface AgenticToolModelSelection {
  provider: string;
  model: string;
}

export interface AgenticToolModelSelectorProps {
  value?: AgenticToolModelSelection;
  onChange?: (config: AgenticToolModelSelection | undefined) => void;
  client?: AgorClient | null;
  branchId?: string;
  catalogEnabled?: boolean;
  compact?: boolean;
  getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
}

export interface AgenticToolUIIntegration {
  ModelSelector?: ComponentType<AgenticToolModelSelectorProps>;
  ProviderSettings?: ComponentType<{ client: AgorClient }>;
}

const UI_INTEGRATIONS: Partial<Record<AgenticToolName, AgenticToolUIIntegration>> = {
  [OPENCODE_UI_CONTRIBUTION.name]: {
    ModelSelector: OPENCODE_UI_CONTRIBUTION.ModelSelector,
    ProviderSettings: OPENCODE_UI_CONTRIBUTION.ProviderSettings,
  },
};

export function getAgenticToolUIIntegration(
  tool: AgenticToolName
): AgenticToolUIIntegration | undefined {
  return UI_INTEGRATIONS[tool];
}

export * from '@agor/agentic-tool-opencode/ui';
