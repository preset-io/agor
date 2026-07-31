import { OPENCODE_INTEGRATION } from '@agor/agentic-tool-opencode';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '@agor/core/models';
import type { AgenticToolName, PersistedAgenticToolName } from '@agor/core/types';
import type {
  AgenticToolDisplayNames,
  AgenticToolIntegration,
  AgenticToolIntegrationRegistry,
} from './types.js';

export type {
  AgenticToolDisplayNames,
  AgenticToolIntegration,
  AgenticToolIntegrationRegistry,
  AgenticToolModelConfiguration,
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
    capabilities: {
      supportsSessionFork: true,
      supportsChildSpawn: true,
      supportsSessionImport: true,
      reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'high',
    },
    configuration: { defaultModel: DEFAULT_CLAUDE_MODEL },
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
      supportsSessionImport: false,
      reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh'],
    },
    configuration: { defaultModel: DEFAULT_CODEX_MODEL },
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
      supportsSessionImport: false,
    },
    configuration: { defaultModel: DEFAULT_GEMINI_MODEL },
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
      supportsSessionImport: false,
    },
    configuration: { defaultModel: DEFAULT_COPILOT_MODEL },
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
      supportsSessionImport: false,
    },
    configuration: {},
  }),
}) satisfies AgenticToolIntegrationRegistry;

export const AGENTIC_TOOL_NAMES = Object.freeze(
  Object.keys(AGENTIC_TOOL_INTEGRATIONS) as AgenticToolName[]
);

export function getAgenticToolIntegration(tool: AgenticToolName): AgenticToolIntegration {
  return AGENTIC_TOOL_INTEGRATIONS[tool];
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

export const AGENTIC_TOOL_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    Object.values(AGENTIC_TOOL_INTEGRATIONS).map((integration) => [
      integration.name,
      integration.capabilities,
    ])
  ) as {
    readonly [Tool in AgenticToolName]: (typeof AGENTIC_TOOL_INTEGRATIONS)[Tool]['capabilities'];
  }
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

export function getAgenticToolDisplayName(tool: PersistedAgenticToolName): string {
  return AGENTIC_TOOL_DISPLAY_NAMES[tool];
}

export function getDefaultModelForTool(tool: AgenticToolName): string | undefined {
  return AGENTIC_TOOL_INTEGRATIONS[tool].configuration.defaultModel;
}

export function isAgenticToolAuthenticationRuntimeManaged(tool: AgenticToolName): boolean {
  return AGENTIC_TOOL_INTEGRATIONS[tool].authentication === 'runtime-managed';
}

export function agenticToolRequiresModelSelection(tool: AgenticToolName): boolean {
  return Boolean(AGENTIC_TOOL_INTEGRATIONS[tool].configuration.missingSelectionError);
}

export function isAgenticToolModelSelectionComplete(
  tool: AgenticToolName,
  input: Parameters<NonNullable<AgenticToolIntegration['configuration']['isSelectionComplete']>>[0]
): boolean {
  const predicate = AGENTIC_TOOL_INTEGRATIONS[tool].configuration.isSelectionComplete;
  return predicate ? predicate(input) : Boolean(input?.model?.trim());
}
