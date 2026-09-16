import {
  OPENCODE_UI_CONTRIBUTION,
  useOpenCodeReasoningEffortLevels,
} from '@agor/agentic-tool-opencode/ui';
import type { AgorClient } from '@agor/core/client';
import type { AgenticToolName, EffortLevel, PermissionMode } from '@agor/core/types';
import type { ComponentType, ReactNode } from 'react';

export interface AgenticToolModelSelection {
  provider: string;
  model: string;
}

export interface AgenticToolModelSelectorProps {
  value?: AgenticToolModelSelection;
  onChange?: (config: AgenticToolModelSelection | undefined) => void;
  /** Fired only when the user finishes selecting a provider/model pair. */
  onCommit?: (config: AgenticToolModelSelection) => void;
  /** Reports advisory model-level effort support; undefined means runtime-validated. */
  onReasoningEffortLevelsChange?: (availability: {
    provider: string;
    model: string;
    levels: readonly EffortLevel[] | undefined;
  }) => void;
  client?: AgorClient | null;
  branchId?: string;
  catalogEnabled?: boolean;
  compact?: boolean;
  getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
}

export interface AgenticToolReadiness {
  tone: 'positive' | 'neutral' | 'info';
  label: string;
}

export interface AgenticToolReadinessProps {
  client?: AgorClient | null;
  canLoadReadiness?: boolean;
  children: (status: AgenticToolReadiness) => ReactNode;
}

export interface AgenticToolUIIntegration {
  agentSelectionOption?: {
    icon: string;
    description: string;
    beta?: boolean;
  };
  onboardingOption?: {
    symbol: string;
    title: string;
    description: string;
  };
  modelLabel?: string;
  ModelSelector?: ComponentType<AgenticToolModelSelectorProps>;
  ProviderSettings?: ComponentType<{
    client: AgorClient;
    copyText: (text: string) => Promise<boolean>;
  }>;
  Readiness?: ComponentType<AgenticToolReadinessProps>;
  permissionModes?: readonly {
    mode: PermissionMode;
    label: string;
    description: string;
    icon: 'lock' | 'edit' | 'unlock';
    tone: 'danger' | 'success' | 'info' | 'warning';
  }[];
}

const UI_INTEGRATIONS: Partial<Record<AgenticToolName, AgenticToolUIIntegration>> = {
  [OPENCODE_UI_CONTRIBUTION.name]: OPENCODE_UI_CONTRIBUTION,
};

export function getAgenticToolUIIntegration(tool: 'opencode'): AgenticToolUIIntegration & {
  agentSelectionOption: NonNullable<AgenticToolUIIntegration['agentSelectionOption']>;
  onboardingOption: NonNullable<AgenticToolUIIntegration['onboardingOption']>;
};
export function getAgenticToolUIIntegration(
  tool: AgenticToolName
): AgenticToolUIIntegration | undefined;
export function getAgenticToolUIIntegration(
  tool: AgenticToolName
): AgenticToolUIIntegration | undefined {
  return UI_INTEGRATIONS[tool];
}

/**
 * Returns exact-model effort metadata owned by an agent integration. Missing
 * means the tool has no model-level contract, or the exact pair must be
 * validated by the runtime; an empty list is an authoritative unsupported set.
 */
export function useAgenticToolReasoningEffortLevels(input: {
  tool: AgenticToolName;
  selection?: AgenticToolModelSelection;
  client?: AgorClient | null;
  branchId?: string;
  catalogEnabled?: boolean;
}): readonly EffortLevel[] | undefined {
  const { tool, selection, client, branchId, catalogEnabled = true } = input;
  const { levels } = useOpenCodeReasoningEffortLevels({
    client,
    branchId,
    catalogEnabled: tool === 'opencode' && catalogEnabled,
    provider: selection?.provider,
    model: selection?.model,
  });
  return tool === 'opencode' ? levels : undefined;
}
