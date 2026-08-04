/**
 * OpenCode Tool Module
 *
 * Integration with OpenCode.ai - open-source terminal-based AI coding assistant.
 * Supports 75+ LLM providers with privacy-first architecture.
 *
 * Uses official @opencode-ai/sdk for all API interactions.
 */

export type {
  OpenCodeToolDependencies,
  OpenCodeTurnResult,
  RunOpenCodeTurnInput,
} from './opencode-tool.js';
export {
  isOpenCodeCleanupUnverifiedError,
  OpenCodeCleanupUnverifiedError,
  OpenCodeInteractionTimeoutError,
  OpenCodePermissionRejectedError,
  OpenCodeTool,
} from './opencode-tool.js';
