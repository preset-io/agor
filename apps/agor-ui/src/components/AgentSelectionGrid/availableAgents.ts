/**
 * Available Agentic Tools
 *
 * Single source of truth for the list of available coding agents.
 * Used across NewSessionModal, ScheduleTab, and other agent selection UIs.
 */

import { AGENTIC_TOOL_DISPLAY_NAMES } from '@agor/agentic-tools';
import { getAgenticToolUIIntegration } from '@agor/agentic-tools/ui';
import type {
  AgenticToolName,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
  User,
} from '@agor-live/client';
import { resolveUserPrimaryAgenticTool } from '@agor-live/client';
import type { AgenticToolOption } from './AgentSelectionGrid';

const openCodeOption = getAgenticToolUIIntegration('opencode').agentSelectionOption;

export const AVAILABLE_AGENTS: AgenticToolOption[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: '🤖',
    description: 'Anthropic Claude coding agent',
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: '💻',
    description: 'OpenAI Codex coding agent',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    icon: '💎',
    description: 'Google Gemini coding agent',
  },
  {
    id: 'opencode',
    name: AGENTIC_TOOL_DISPLAY_NAMES.opencode,
    icon: openCodeOption.icon,
    description: openCodeOption.description,
    beta: openCodeOption.beta,
  },
  {
    id: 'cursor',
    name: 'Cursor SDK',
    icon: '⌘',
    description: 'Cursor agentic runtime via the Cursor SDK',
    beta: true,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    icon: '✈️',
    description: 'GitHub Copilot agentic runtime',
    beta: true,
  },
];

/**
 * Resolve the tool that a creation picker will actually select once workspace
 * availability is known: the user's primary/default tool when visible, then
 * the first enabled option in the picker's canonical display order.
 *
 * Persistent shell affordances (including credential status) must use this
 * helper rather than inferring a tool from stored credentials. A credential
 * for another provider does not change which tool New Session selects.
 */
export function resolveAvailableUserAgenticTool(
  user: User | null | undefined,
  settings: ReadonlyMap<TenantAgenticToolName, TenantAgenticToolSettings>,
  agents: readonly AgenticToolOption[] = AVAILABLE_AGENTS
): AgenticToolName {
  return resolveAvailableAgenticTool(resolveUserPrimaryAgenticTool(user), settings, agents);
}

/** Apply the creation picker's enabled-tool fallback to an explicit preference. */
export function resolveAvailableAgenticTool(
  preferred: AgenticToolName,
  settings: ReadonlyMap<TenantAgenticToolName, TenantAgenticToolSettings>,
  agents: readonly AgenticToolOption[] = AVAILABLE_AGENTS
): AgenticToolName {
  const isEnabled = (tool: string) =>
    settings.get(tool as TenantAgenticToolName)?.enabled !== false;

  if (agents.some((agent) => agent.id === preferred && isEnabled(agent.id))) return preferred;
  return (
    (agents.find((agent) => isEnabled(agent.id))?.id as AgenticToolName | undefined) ?? preferred
  );
}
