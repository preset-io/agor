/**
 * SDK Response Types - Raw responses from each agentic tool SDK
 *
 * These types represent the exact, unaltered responses from each SDK.
 * They are stored in tasks.raw_sdk_response for debugging and auditing.
 *
 * IMPORTANT: These are the ACTUAL SDK types, imported directly from each SDK.
 * No transformations, no calculated fields - just pure SDK responses.
 */

import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { ServerGeminiFinishedEvent } from '@google/gemini-cli-core';
import type { TurnCompletedEvent } from '@openai/codex-sdk';
import type { MessageID } from './id';

// ============================================================================
// Claude Code SDK Response (from Anthropic Claude Agent SDK)
// ============================================================================

/**
 * Claude Code SDK Response - Direct import from Claude Agent SDK
 * This is the actual SDKResultMessage type with no modifications
 */
export type ClaudeCodeSdkResponse = SDKResultMessage;

// ============================================================================
// Codex SDK Response (from OpenAI Codex SDK)
// ============================================================================

/**
 * Codex SDK Response - Direct import from Codex SDK
 * This is the actual TurnCompletedEvent type with no modifications
 */
export type CodexSdkResponse = TurnCompletedEvent;

// ============================================================================
// Gemini SDK Response (from Google Gemini CLI SDK)
// ============================================================================

/**
 * Gemini SDK Response - Direct import from Gemini SDK
 * This is the actual ServerGeminiFinishedEvent type with no modifications
 */
export type GeminiSdkResponse = ServerGeminiFinishedEvent;

// ============================================================================
// OpenCode SDK Response
// ============================================================================

/**
 * OpenCode SDK Response - Currently unknown structure
 * TODO: Import actual OpenCode SDK type when available
 */
export type OpenCodeSdkResponse = unknown;

// ============================================================================
// Union Type - All Raw SDK Responses
// ============================================================================

/**
 * Union of all raw SDK response types
 * This is what gets stored in tasks.raw_sdk_response
 */
export type RawSdkResponse =
  | ClaudeCodeSdkResponse
  | CodexSdkResponse
  | GeminiSdkResponse
  | OpenCodeSdkResponse;

// ============================================================================
// Legacy/Deprecated Types (for backward compatibility)
// ============================================================================

/**
 * @deprecated Use normalizeRawSdkResponse() from utils/sdk-normalizer instead
 * This interface represents normalized/computed data, not raw SDK responses
 */
export interface NormalizedSdkResponse {
  userMessageId: MessageID;
  assistantMessageIds: MessageID[];
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  durationMs?: number;
  contextWindow?: number;
  contextWindowLimit?: number;
  model?: string;
  /**
   * Per-model usage breakdown (for multi-model sessions like Claude Code)
   * Maps model ID to usage stats including context window per model
   */
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      contextWindow: number;
    }
  >;
}
