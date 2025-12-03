/**
 * SDK Response Normalizer Factory
 *
 * Dispatches to the appropriate normalizer based on agentic tool type.
 * This is the single entry point for normalizing raw SDK responses into
 * the standardized format used by UI and analytics.
 *
 * Usage:
 *   const normalized = normalizeRawSdkResponse('claude-code', rawSdkResponse);
 */

import type { NormalizedSdkData } from './base/normalizer.interface.js';
import { ClaudeCodeNormalizer } from './claude/normalizer.js';
import { CodexNormalizer } from './codex/normalizer.js';
import { GeminiNormalizer } from './gemini/normalizer.js';

// Singleton instances (normalizers are stateless, so one instance is fine)
const claudeNormalizer = new ClaudeCodeNormalizer();
const codexNormalizer = new CodexNormalizer();
const geminiNormalizer = new GeminiNormalizer();

/**
 * Normalize raw SDK response to common format
 *
 * @param agenticTool - The agentic tool type (determines which normalizer to use)
 * @param rawSdkResponse - Raw SDK response from the tool
 * @returns Normalized data with consistent structure, or undefined if normalization fails
 */
export function normalizeRawSdkResponse(
  agenticTool: 'claude-code' | 'codex' | 'gemini' | 'opencode' | string,
  rawSdkResponse: unknown
): NormalizedSdkData | undefined {
  if (!rawSdkResponse) {
    return undefined;
  }

  try {
    switch (agenticTool) {
      case 'claude-code':
        return claudeNormalizer.normalize(
          rawSdkResponse as Parameters<typeof claudeNormalizer.normalize>[0]
        );

      case 'codex':
        return codexNormalizer.normalize(
          rawSdkResponse as Parameters<typeof codexNormalizer.normalize>[0]
        );

      case 'gemini':
        return geminiNormalizer.normalize(
          rawSdkResponse as Parameters<typeof geminiNormalizer.normalize>[0]
        );

      case 'opencode':
        // OpenCode doesn't have a normalizer yet - return undefined
        console.debug('[Normalizer] OpenCode normalizer not implemented yet');
        return undefined;

      default:
        console.warn(`[Normalizer] Unknown agentic tool: ${agenticTool}`);
        return undefined;
    }
  } catch (error) {
    console.error(`[Normalizer] Failed to normalize ${agenticTool} response:`, error);
    return undefined;
  }
}
