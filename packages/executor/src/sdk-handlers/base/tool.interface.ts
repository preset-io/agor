/**
 * ITool - Base interface for agentic coding tool integrations
 *
 * Single unified interface for all tool interactions.
 * Methods are optional based on tool capabilities.
 *
 * Design philosophy:
 * - Functionality-oriented (what you can DO)
 * - Optional methods based on capabilities
 * - Start simple, expand as we learn from multiple tools
 * - Don't split into Client/Session unless runtime separation is clear
 */

import type { Message } from '@agor/core/types';
import type { NormalizedSdkResponse, RawSdkResponse } from '../../types/sdk-response.js';
import type {
  CreateSessionConfig,
  ImportOptions,
  MessageRange,
  SessionData,
  SessionHandle,
  SessionMetadata,
  StreamingCallbacks,
  TaskResult,
  ToolCapabilities,
  ToolType,
} from './types.js';

export interface ITool {
  // ============================================================
  // Identity
  // ============================================================

  /** Tool type identifier */
  readonly toolType: ToolType;

  /** Human-readable tool name */
  readonly name: string;

  // ============================================================
  // Capabilities & Installation
  // ============================================================

  /**
   * Get tool capabilities (feature flags)
   */
  getCapabilities(): ToolCapabilities;

  /**
   * Check if tool is installed and accessible
   */
  checkInstalled(): Promise<boolean>;

  // ============================================================
  // Session Import (if supportsSessionImport)
  // ============================================================

  /**
   * Import existing session from tool's storage
   *
   * Example: Load Claude Code session from ~/.claude/projects/
   *
   * @param sessionId - Tool's session identifier
   * @param options - Import options (e.g., project directory)
   * @returns Rich session data with messages and metadata
   */
  importSession?(sessionId: string, options?: ImportOptions): Promise<SessionData>;

  // ============================================================
  // Session Creation (if supportsSessionCreate)
  // ============================================================

  /**
   * Create new session via SDK/API
   *
   * @param config - Session configuration
   * @returns Session handle (minimal identifier)
   */
  createSession?(config: CreateSessionConfig): Promise<SessionHandle>;

  // ============================================================
  // Live Execution (if supportsLiveExecution)
  // ============================================================

  /**
   * Execute task (send prompt) in existing session
   *
   * CONTRACT:
   * - MANDATORY: Must call messagesService.create() with complete message when done
   * - MANDATORY: Complete message automatically broadcasts via FeathersJS
   * - OPTIONAL: If supportsStreaming=true, may call streamingCallbacks during execution
   *
   * STREAMING:
   * - If streamingCallbacks provided AND supportsStreaming=true:
   *   - Call onStreamStart() before generating
   *   - Call onStreamChunk() for each 3-10 word chunk
   *   - Call onStreamEnd() after generating
   *   - Then create complete message in DB
   * - If streamingCallbacks not provided OR supportsStreaming=false:
   *   - Execute synchronously
   *   - Create complete message in DB
   *   - User sees loading spinner, then full message
   *
   * @param sessionId - Session identifier
   * @param prompt - User prompt
   * @param taskId - Task identifier (for linking messages)
   * @param streamingCallbacks - Optional callbacks for real-time streaming (ignored if !supportsStreaming)
   * @returns Task result with message IDs
   */
  executeTask?(
    sessionId: string,
    prompt: string,
    taskId?: string,
    streamingCallbacks?: StreamingCallbacks
  ): Promise<TaskResult>;

  // ============================================================
  // Session Operations (if supported)
  // ============================================================

  /**
   * Get session metadata
   */
  getSessionMetadata?(sessionId: string): Promise<SessionMetadata>;

  /**
   * Get messages from session
   */
  getSessionMessages?(sessionId: string, range?: MessageRange): Promise<Message[]>;

  /**
   * List all available sessions
   */
  listSessions?(): Promise<SessionMetadata[]>;

  // ============================================================
  // Advanced Features (if supported)
  // ============================================================

  /**
   * Fork session at specific message index
   *
   * Creates divergent exploration path
   */
  forkSession?(sessionId: string, atMessageIndex?: number): Promise<SessionHandle>;

  /**
   * Spawn child session for subsession
   *
   * Creates focused subsession session with minimal context
   */
  spawnChildSession?(parentSessionId: string, prompt: string): Promise<SessionHandle>;

  // ============================================================
  // Task Lifecycle Control (if supportsLiveExecution)
  // ============================================================

  /**
   * Stop currently executing task in session
   *
   * Gracefully terminates the agent's current execution.
   * Implementation varies by SDK:
   * - Claude Agent SDK: Call interrupt() on Query object
   * - Gemini SDK: Call abort() on AbortController
   * - Codex SDK: Set stop flag and break event loop
   *
   * @param sessionId - Session identifier
   * @param taskId - Optional task ID to stop (if multiple tasks running)
   * @returns Success status and partial results if available
   */
  stopTask?(
    sessionId: string,
    taskId?: string
  ): Promise<{
    success: boolean;
    partialResult?: Partial<TaskResult>;
    reason?: string;
  }>;

  // ============================================================
  // Token Accounting (Required for all tools)
  // ============================================================

  /**
   * Normalize raw SDK response to common format
   *
   * Converts tool-specific SDK response into a normalized structure
   * with consistent field names and types across all agentic tools.
   *
   * This enables:
   * - Consistent UI display
   * - Cross-tool token accounting
   * - Easier debugging
   *
   * @param rawResponse - Raw SDK response from executeTask/executePrompt
   * @returns Normalized response with common structure
   */
  normalizedSdkResponse(rawResponse: RawSdkResponse): NormalizedSdkResponse;

  /**
   * Compute cumulative context window usage for a session
   *
   * Each agentic tool implements its own strategy for tracking context:
   * - **Claude Code**: Sums input/output tokens across tasks, resets on compaction events
   * - **Codex**: May use SDK's cumulative reporting (if available)
   * - **Gemini**: May use different tracking approach
   * - **Others**: Can return current context from latest task's SDK response
   *
   * The computed value is stored in `Task.computed_context_window` for efficient access.
   *
   * @param sessionId - Session ID to compute context for
   * @param currentTaskId - Current task ID (to exclude from computation, as it's not complete yet)
   * @returns Promise resolving to computed context window usage in tokens
   */
  computeContextWindow?(sessionId: string, currentTaskId?: string): Promise<number>;
}
