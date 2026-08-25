import type { MCPRuntimeProviderCapability, PersistedAgenticToolName } from '../types/index.js';

const NEXT_TURN = (reason: string): MCPRuntimeProviderCapability => ({
  mode: 'next_turn',
  transport_reload: false,
  retries_unstarted_call: false,
  reason,
});

/**
 * Pinned to the public APIs in the SDK versions shipped by this tree.
 * Do not infer support from private methods or a provider CLI implementation.
 */
export const MCP_RUNTIME_PROVIDER_CAPABILITIES: Readonly<
  Record<PersistedAgenticToolName, MCPRuntimeProviderCapability>
> = {
  'claude-code': {
    mode: 'in_place',
    transport_reload: true,
    retries_unstarted_call: false,
    reason:
      'setMcpServers safely replaces SDK-owned MCP transports; the SDK does not expose replay of a failed model tool call.',
  },
  copilot: NEXT_TURN(
    'Copilot exposes session reload only for its persisted CLI MCP configuration; Agor cannot safely replace the task-scoped in-memory projection without persisting a capability.'
  ),
  codex: NEXT_TURN('The Codex SDK fixes MCP configuration when a turn starts.'),
  gemini: NEXT_TURN('Gemini CLI core exposes no public live MCP manager mutation API.'),
  opencode: NEXT_TURN(
    'OpenCode exposes connect APIs, but its managed turn does not expose a call-boundary-safe reload hook.'
  ),
  cursor: NEXT_TURN('Cursor MCP configuration is fixed on create/resume and per-run send options.'),
  'claude-code-cli': NEXT_TURN(
    'Legacy Claude CLI sessions do not expose the Agent SDK task-scoped transport replacement API.'
  ),
};

export function mcpRuntimeProviderCapability(
  provider: PersistedAgenticToolName
): MCPRuntimeProviderCapability {
  return MCP_RUNTIME_PROVIDER_CAPABILITIES[provider];
}
