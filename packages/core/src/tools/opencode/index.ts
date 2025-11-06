/**
 * OpenCode Tool Module
 *
 * Integration with OpenCode.ai - open-source terminal-based AI coding assistant.
 * Supports 75+ LLM providers with privacy-first architecture.
 */

export { OpenCodeClient } from './client';
export type {
  OpenCodeConfig,
  OpenCodeMessageEvent,
  OpenCodeSession,
} from './client';

export { OpenCodeTool } from './opencode-tool';
export type { OpenCodeConfig as OpenCodeToolConfig } from './opencode-tool';
