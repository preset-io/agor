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
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    icon: '✈️',
    description: 'GitHub Copilot agentic runtime',
    beta: true,
  },
  {
    id: 'claude-code-cli',
    name: 'Claude Code CLI',
    icon: '🤖',
    description:
      'Wraps the `claude` shell binary in your web terminal. Best with a Claude Pro/Max subscription — uses your normal interactive limits, not the Agent SDK credit pool.',
    beta: true,
  },
];
