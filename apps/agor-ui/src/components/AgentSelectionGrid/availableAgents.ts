/**
 * Available Agentic Tools
 *
 * Single source of truth for the list of available coding agents.
 * Used across NewSessionModal, ScheduleTab, and other agent selection UIs.
 */

import { AGENTIC_TOOL_DISPLAY_NAMES } from '@agor/agentic-tools';
import { getAgenticToolUIIntegration } from '@agor/agentic-tools/ui';
import type { AgenticToolOption } from './AgentSelectionGrid';

const openCodeOption = getAgenticToolUIIntegration('opencode')?.agentSelectionOption;

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
    icon: openCodeOption?.icon ?? '',
    description: openCodeOption?.description ?? '',
    beta: openCodeOption?.beta,
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
