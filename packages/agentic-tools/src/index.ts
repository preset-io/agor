import { OPENCODE_INTEGRATION } from '@agor/agentic-tool-opencode';
import type { AgenticToolCapabilities, AgenticToolName } from '@agor/core/types';
import type {
  AgenticToolDisplayNames,
  AgenticToolIntegration,
  AgenticToolIntegrationRegistry,
} from './types.js';

export type {
  AgenticToolDisplayNames,
  AgenticToolIntegration,
  AgenticToolIntegrationRegistry,
  ConfigHomeOverride,
  ConfigHomeSemantics,
} from './types.js';

/**
 * An integration as authored: identical to {@link AgenticToolIntegration}
 * except `supportsConfigHomeOverride` is omitted from `capabilities`. That flag
 * is derived — never hand-set — by {@link defineIntegration} from the presence
 * of `configHomeOverride`, so the boolean and the mapping cannot drift apart.
 */
type AgenticToolIntegrationInput = Omit<AgenticToolIntegration, 'capabilities'> & {
  capabilities: Omit<AgenticToolCapabilities, 'supportsConfigHomeOverride'>;
};

function defineIntegration(integration: AgenticToolIntegrationInput): AgenticToolIntegration {
  return Object.freeze({
    ...integration,
    capabilities: {
      ...integration.capabilities,
      // Single source of truth: a tool supports config-home relocation iff it
      // carries an env-var mapping for it. Keeps the two consistent by
      // construction (invariant asserted in index.test.ts).
      supportsConfigHomeOverride: integration.configHomeOverride !== undefined,
    },
  });
}

export const AGENTIC_TOOL_INTEGRATIONS = Object.freeze({
  'claude-code': defineIntegration({
    name: 'claude-code',
    displayName: 'Claude Code',
    apiKeyName: 'ANTHROPIC_API_KEY',
    authentication: 'api-key',
    keyCreationUrl: 'https://platform.claude.com/settings/keys',
    billingUrl: 'https://platform.claude.com/settings/billing',
    configHomeOverride: { semantics: 'config-dir', envVars: ['CLAUDE_CONFIG_DIR'] },
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
    // CODEX_SQLITE_HOME relocates Codex's sqlite state independently of
    // CODEX_HOME (design §8A.5); both are the config dir itself.
    configHomeOverride: { semantics: 'config-dir', envVars: ['CODEX_HOME', 'CODEX_SQLITE_HOME'] },
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
    // GEMINI_CLI_HOME is a home ROOT — the CLI appends `.gemini` to it (design
    // §8A.7), so its semantics differ from the config-dir tools.
    configHomeOverride: { semantics: 'home-root', envVars: ['GEMINI_CLI_HOME'] },
    capabilities: {
      supportsSessionFork: false,
      supportsChildSpawn: true,
    },
  }),
  opencode: defineIntegration({
    ...OPENCODE_INTEGRATION,
    // OpenCode relocates via the XDG base dirs (already wired in its runtime);
    // each is a root under which OpenCode creates its own `opencode/` subdir.
    configHomeOverride: {
      semantics: 'home-root',
      envVars: ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'],
    },
  }),
  copilot: defineIntegration({
    name: 'copilot',
    displayName: 'GitHub Copilot',
    apiKeyName: 'COPILOT_GITHUB_TOKEN',
    authentication: 'api-key',
    keyCreationUrl: 'https://github.com/settings/tokens',
    // COPILOT_CACHE_HOME must be set alongside COPILOT_HOME — the cache does not
    // follow COPILOT_HOME on its own (design §8A.6 item 5). NOTE: on the pinned
    // @github/copilot-sdk 0.2.2 these are delivered at runtime through
    // CopilotClientOptions.env (design §8A.8); Phase 2 only records the names.
    configHomeOverride: {
      semantics: 'config-dir',
      envVars: ['COPILOT_HOME', 'COPILOT_CACHE_HOME'],
    },
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
    // No configHomeOverride: Cursor's relocation is confirmed broken upstream —
    // CURSOR_CONFIG_DIR moves only the config file and a hardcoded ~/.cursor
    // path remains in the shipped bundle (design §5). Its absence is what makes
    // supportsConfigHomeOverride resolve to false for this tool.
    capabilities: {
      supportsSessionFork: false,
      supportsChildSpawn: true,
    },
  }),
  workload: defineIntegration({
    name: 'workload',
    displayName: 'Deterministic workload',
    authentication: 'built-in',
    capabilities: {
      supportsSessionFork: false,
      supportsChildSpawn: false,
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
