import { OPENCODE_UI_CONTRIBUTION } from '@agor/agentic-tool-opencode/ui';
import type { AgorClient } from '@agor/core/client';
import type { AgenticToolName, PermissionMode } from '@agor/core/types';
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
  onboardingOption?: {
    symbol: string;
    title: string;
    description: string;
  };
  modelLabel?: string;
  ModelSelector?: ComponentType<AgenticToolModelSelectorProps>;
  ProviderSettings?: ComponentType<{ client: AgorClient }>;
  permissionModes?: readonly {
    mode: PermissionMode;
    label: string;
    description: string;
    icon: 'lock' | 'edit' | 'unlock';
    tone: 'danger' | 'success' | 'info' | 'warning';
  }[];
}

const UI_INTEGRATIONS: Partial<Record<AgenticToolName, AgenticToolUIIntegration>> = {
  [OPENCODE_UI_CONTRIBUTION.name]: {
    onboardingOption: OPENCODE_UI_CONTRIBUTION.onboardingOption,
    modelLabel: OPENCODE_UI_CONTRIBUTION.modelLabel,
    ModelSelector: OPENCODE_UI_CONTRIBUTION.ModelSelector,
    ProviderSettings: OPENCODE_UI_CONTRIBUTION.ProviderSettings,
    permissionModes: OPENCODE_UI_CONTRIBUTION.permissionModes,
  },
};

export function getAgenticToolUIIntegration(
  tool: AgenticToolName
): AgenticToolUIIntegration | undefined {
  return UI_INTEGRATIONS[tool];
}

export function getAgenticToolUIIntegrations(): ReadonlyArray<
  readonly [AgenticToolName, AgenticToolUIIntegration]
> {
  return Object.entries(UI_INTEGRATIONS) as Array<[AgenticToolName, AgenticToolUIIntegration]>;
}

export * from '@agor/agentic-tool-opencode/ui';
