import { OPENCODE_INTEGRATION } from '@agor/agentic-tool-opencode';
import type { AgenticToolName } from '@agor/core/types';
import type {
  AgenticToolDisplayNames,
  AgenticToolIntegration,
  AgenticToolIntegrationRegistry,
} from './types.js';

export type {
  AgenticToolDisplayNames,
  AgenticToolIntegration,
  AgenticToolIntegrationRegistry,
} from './types.js';

function defineIntegration(integration: AgenticToolIntegration): AgenticToolIntegration {
  return Object.freeze(integration);
}

export const AGENTIC_TOOL_INTEGRATIONS = Object.freeze({
  'claude-code': defineIntegration({
    name: 'claude-code',
    displayName: 'Claude Code',
    apiKeyName: 'ANTHROPIC_API_KEY',
    authentication: 'api-key',
    keyCreationUrl: 'https://platform.claude.com/settings/keys',
    billingUrl: 'https://platform.claude.com/settings/billing',
    capabilities: {
      supportsSessionFork: true,
      supportsChildSpawn: true,
      reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'high',
    },
  }),
  codex: defineIntegration({
    name: 'codex',
    displayName: 'Codex',
    apiKeyName: 'OPENAI_API_KEY',
    authentication: 'api-key',
    keyCreationUrl: 'https://platform.openai.com/api-keys',
    capabilities: {
      supportsSessionFork: true,
      supportsChildSpawn: true,
      reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  }),
  gemini: defineIntegration({
    name: 'gemini',
    displayName: 'Gemini',
    apiKeyName: 'GEMINI_API_KEY',
    authentication: 'api-key',
    keyCreationUrl: 'https://aistudio.google.com/app/apikey',
    capabilities: {
      supportsSessionFork: false,
      supportsChildSpawn: true,
    },
  }),
  opencode: defineIntegration(OPENCODE_INTEGRATION),
  copilot: defineIntegration({
    name: 'copilot',
    displayName: 'GitHub Copilot',
    apiKeyName: 'COPILOT_GITHUB_TOKEN',
    authentication: 'api-key',
    keyCreationUrl: 'https://github.com/settings/tokens',
    capabilities: {
      supportsSessionFork: false,
      supportsChildSpawn: true,
    },
  }),
  cursor: defineIntegration({
    name: 'cursor',
    displayName: 'Cursor SDK',
    apiKeyName: 'CURSOR_API_KEY',
    authentication: 'api-key',
    keyCreationUrl: 'https://cursor.com/dashboard/integrations',
    capabilities: {
      supportsSessionFork: false,
      supportsChildSpawn: true,
    },
  }),
}) satisfies AgenticToolIntegrationRegistry;

export function getAgenticToolIntegration(tool: AgenticToolName): AgenticToolIntegration {
  return AGENTIC_TOOL_INTEGRATIONS[tool];
}

export function getAgenticToolModelSelectionError(
  tool: AgenticToolName,
  input: { provider?: string; model?: string } | null | undefined
): string | undefined {
  const policy = AGENTIC_TOOL_INTEGRATIONS[tool].modelConfiguration;
  if (!policy?.missingSelectionError) return undefined;
  return isAgenticToolModelSelectionComplete(tool, input)
    ? undefined
    : policy.missingSelectionError;
}

export function agenticToolRequiresModelSelection(tool: AgenticToolName): boolean {
  return Boolean(AGENTIC_TOOL_INTEGRATIONS[tool].modelConfiguration?.missingSelectionError);
}

export function getAgenticToolModelConfiguration(tool: AgenticToolName) {
  return AGENTIC_TOOL_INTEGRATIONS[tool].modelConfiguration;
}

export function isAgenticToolModelSelectionComplete(
  tool: AgenticToolName,
  input: { provider?: string; model?: string } | null | undefined
): boolean {
  const predicate = AGENTIC_TOOL_INTEGRATIONS[tool].modelConfiguration?.isSelectionComplete;
  return predicate ? predicate(input) : Boolean(input?.model?.trim());
}

export const TOOL_API_KEY_NAMES = Object.freeze(
  Object.fromEntries(
    Object.values(AGENTIC_TOOL_INTEGRATIONS).flatMap((integration) =>
      integration.apiKeyName ? [[integration.name, integration.apiKeyName]] : []
    )
  ) as Partial<Record<AgenticToolName, NonNullable<AgenticToolIntegration['apiKeyName']>>>
);

export const AGENTIC_TOOL_KEY_CREATION_URL = Object.freeze(
  Object.fromEntries(
    Object.values(AGENTIC_TOOL_INTEGRATIONS).flatMap((integration) =>
      integration.keyCreationUrl ? [[integration.name, integration.keyCreationUrl]] : []
    )
  ) as Partial<Record<AgenticToolName, string>>
);

export const AGENTIC_TOOL_BILLING_URL = Object.freeze(
  Object.fromEntries(
    Object.values(AGENTIC_TOOL_INTEGRATIONS).flatMap((integration) =>
      integration.billingUrl ? [[integration.name, integration.billingUrl]] : []
    )
  ) as Partial<Record<AgenticToolName, string>>
);

export const AGENTIC_TOOL_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    Object.values(AGENTIC_TOOL_INTEGRATIONS).map((integration) => [
      integration.name,
      integration.capabilities,
    ])
  ) as Readonly<Record<AgenticToolName, AgenticToolIntegration['capabilities']>>
);

export const AGENTIC_TOOL_DISPLAY_NAMES = Object.freeze({
  ...Object.fromEntries(
    Object.values(AGENTIC_TOOL_INTEGRATIONS).map((integration) => [
      integration.name,
      integration.displayName,
    ])
  ),
  'claude-code-cli': 'Claude Code CLI (removed)',
}) as AgenticToolDisplayNames;
