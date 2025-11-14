/**
 * SDK Response Types - Raw responses from each agentic tool SDK
 *
 * These types represent the exact, unaltered responses from each SDK.
 * They are stored in tasks.raw_sdk_response for debugging and auditing.
 */

import type { MessageID } from './id';
import type { TokenUsage } from '../utils/pricing';

// ============================================================================
// Claude Code SDK Response (from Anthropic Claude Agent SDK)
// ============================================================================

export interface ClaudeCodeSdkResponse {
  userMessageId: MessageID;
  assistantMessageIds: MessageID[];
  tokenUsage?: TokenUsage;
  durationMs?: number;
  agentSessionId?: string;
  contextWindow?: number;
  contextWindowLimit?: number;
  model?: string;
  /**
   * Per-model usage breakdown (for multi-model sessions)
   * Maps model ID to usage stats including context window per model
   */
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      contextWindow: number; // Context window limit for this specific model
    }
  >;
}

// ============================================================================
// Codex SDK Response (from OpenAI Codex SDK)
// ============================================================================

export interface CodexSdkResponse {
  userMessageId: MessageID;
  assistantMessageIds: MessageID[];
  tokenUsage?: TokenUsage;
  durationMs?: number;
  contextWindow?: number;
  contextWindowLimit?: number;
  model?: string;
}

// ============================================================================
// Gemini SDK Response (from Google Gemini CLI SDK)
// ============================================================================

export interface GeminiSdkResponse {
  userMessageId: MessageID;
  assistantMessageIds: MessageID[];
  tokenUsage?: TokenUsage;
  contextWindow?: number;
  contextWindowLimit?: number;
  model?: string;
}

// ============================================================================
// OpenCode SDK Response (from OpenCode.ai server SDK)
// ============================================================================

export interface OpenCodeSdkResponse {
  userMessageId: MessageID;
  assistantMessageIds: MessageID[];
  // OpenCode is early stage, types may evolve
  tokenUsage?: TokenUsage;
  model?: string;
}

// ============================================================================
// Union Type - All SDK Responses
// ============================================================================

/**
 * Raw SDK Response - Union of all agentic tool SDK responses
 *
 * This is stored in tasks.raw_sdk_response field for debugging and auditing.
 * Each SDK response is tagged with a 'tool' discriminator for type safety.
 */
export type RawSdkResponse =
  | ({ tool: 'claude-code' } & ClaudeCodeSdkResponse)
  | ({ tool: 'codex' } & CodexSdkResponse)
  | ({ tool: 'gemini' } & GeminiSdkResponse)
  | ({ tool: 'opencode' } & OpenCodeSdkResponse);

// ============================================================================
// Normalized SDK Response
// ============================================================================

/**
 * Normalized SDK Response - Common structure across all agentic tools
 *
 * This structure provides a consistent interface for:
 * - Token usage accounting
 * - Context window tracking
 * - Cost calculation
 * - UI display
 *
 * Each agentic tool implements normalizedSdkResponse() to convert
 * its raw SDK response to this format.
 */
export interface NormalizedSdkResponse {
  // Message IDs
  userMessageId: MessageID;
  assistantMessageIds: MessageID[];

  // Token usage (normalized across all SDKs)
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number; // 0 for SDKs without caching
    cacheCreationTokens: number; // 0 for SDKs without caching
  };

  // Context window tracking
  contextWindow?: number; // Current usage
  contextWindowLimit?: number; // Model's max limit

  // Model metadata
  model?: string; // Resolved model ID (e.g., "claude-sonnet-4-5-20250929")

  // Execution metadata
  durationMs?: number;
  agentSessionId?: string; // SDK's internal session ID (for debugging)

  // Per-model breakdown (for multi-model sessions like Claude Code)
  perModelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      contextWindowLimit: number;
    }
  >;
}
