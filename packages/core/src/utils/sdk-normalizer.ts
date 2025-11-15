/**
 * SDK Response Normalizer Utility
 *
 * Provides a unified interface to normalize raw SDK responses from any agentic tool.
 * Uses the appropriate normalizer based on the agentic tool type.
 */

import type { NormalizedSdkData } from '../tools/base/normalizer.interface';
import { ClaudeCodeNormalizer } from '../tools/claude/normalizer';
import { CodexNormalizer } from '../tools/codex/normalizer';
import { GeminiNormalizer } from '../tools/gemini/normalizer';
import type { AgenticToolName } from '../types/agentic-tool';

/**
 * Normalize a raw SDK response into standardized format
 *
 * @param rawResponse - Raw SDK event from any agentic tool (unmutated)
 * @param agenticTool - The agentic tool that produced this response (from Session.agentic_tool)
 * @returns Normalized data with computed fields
 *
 * @example
 * ```typescript
 * const task = await tasksRepo.findById(taskId);
 * const session = await sessionsRepo.findById(task.session_id);
 *
 * if (task.raw_sdk_response) {
 *   const normalized = normalizeRawSdkResponse(
 *     task.raw_sdk_response,
 *     session.agentic_tool
 *   );
 *   console.log('Context window:', normalized.contextWindow);
 *   console.log('Tokens:', normalized.tokenUsage);
 * }
 * ```
 */
export function normalizeRawSdkResponse(
  rawResponse: unknown,
  agenticTool: AgenticToolName
): NormalizedSdkData {
  switch (agenticTool) {
    case 'claude-code':
      // biome-ignore lint/suspicious/noExplicitAny: Normalizer accepts unknown, casts internally
      return new ClaudeCodeNormalizer().normalize(rawResponse as any);

    case 'codex':
      // biome-ignore lint/suspicious/noExplicitAny: Normalizer expects typed CodexSdkResponse, casts safely
      return new CodexNormalizer().normalize(rawResponse as any);

    case 'gemini':
      // biome-ignore lint/suspicious/noExplicitAny: Normalizer expects typed GeminiSdkResponse, casts safely
      return new GeminiNormalizer().normalize(rawResponse as any);

    case 'opencode':
      // TODO: Implement OpenCodeNormalizer
      console.warn('OpenCode normalizer not yet implemented');
      return {
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        contextWindow: 0,
        contextWindowLimit: 0,
      };

    default: {
      // Type guard: should never reach here if AgenticToolName is exhaustive
      const _exhaustive: never = agenticTool;
      throw new Error(`Unknown agentic tool: ${_exhaustive}`);
    }
  }
}
