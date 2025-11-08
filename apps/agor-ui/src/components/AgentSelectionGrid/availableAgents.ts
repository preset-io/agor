/**
 * Available Agentic Tools
 *
 * Single source of truth for the list of available coding agents.
 * Used across NewSessionModal, ScheduleTab, and other agent selection UIs.
 */

import type { AgenticToolOption } from './AgentSelectionGrid';

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
    name: 'OpenCode',
    icon: '🌐',
    description: 'Open-source terminal AI with 75+ LLM providers',
    beta: true,
  },
];
