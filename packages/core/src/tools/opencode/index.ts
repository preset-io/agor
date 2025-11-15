/**
 * OpenCode Tool Module
 *
 * Integration with OpenCode.ai - open-source terminal-based AI coding assistant.
 * Supports 75+ LLM providers with privacy-first architecture.
 */

export type { OpenCodeConfig, OpenCodeMessageEvent, OpenCodeSession } from './client';
export { OpenCodeClient } from './client';
export type { OpenCodeConfig as OpenCodeToolConfig } from './opencode-tool';
export { OpenCodeTool } from './opencode-tool';
