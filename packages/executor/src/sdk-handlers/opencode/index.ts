/**
 * OpenCode Tool Module
 *
 * Integration with OpenCode.ai - open-source terminal-based AI coding assistant.
 * Supports 75+ LLM providers with privacy-first architecture.
 */

export type { OpenCodeConfig, OpenCodeMessageEvent, OpenCodeSession } from './client.js';
export { OpenCodeClient } from './client.js';
export type { OpenCodeConfig as OpenCodeToolConfig } from './opencode-tool.js';
export { OpenCodeTool } from './opencode-tool.js';
