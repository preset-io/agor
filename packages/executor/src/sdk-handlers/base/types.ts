/**
 * Tool Types - Base types for agentic coding tools
 *
 * Tools: External agentic coding products (Claude Code, Codex, Gemini)
 * Not to be confused with AI agents (internal personas)
 */

import type { Message, MessageID, SessionID, TaskID } from '@agor/core/types';

/**
 * Supported tool types
 */
export type ToolType = 'claude-code' | 'codex' | 'gemini' | 'opencode';

/**
 * Streaming callback interface for agents that support real-time streaming
 *
 * Agents call these callbacks during message generation to provide progressive updates.
 * If agent doesn't support streaming, it simply calls messagesService.create() at end.
 *
 * Example usage:
 * ```typescript
 * streamingCallbacks.onStreamStart(messageId, { session_id, task_id, role, timestamp });
 * // ... stream chunks ...
 * streamingCallbacks.onStreamChunk(messageId, "Hello world");
 * streamingCallbacks.onStreamEnd(messageId);
 * // Then MANDATORY: messagesService.create() with full message
 * ```
 */
export interface StreamingCallbacks {
  /**
   * Called when message streaming starts
   *
   * @param messageId - Unique ID for this message (agent generates via UUIDv4)
   * @param metadata - Initial metadata (role, timestamp, etc.)
   */
  onStreamStart(
    messageId: MessageID,
    metadata: {
      session_id: SessionID;
      task_id?: TaskID;
      role: string;
      timestamp: string;
    }
  ): Promise<void>;

  /**
   * Called for each chunk of streamed content
   *
   * Recommended chunk size: 3-10 words for optimal UX/performance balance.
   * Buffer tokens and flush at sentence boundaries (., !, ?, \n\n) or word count threshold.
   *
   * @param messageId - Message being streamed
   * @param chunk - Text chunk (3-10 words recommended)
   * @param sequence - Monotonically increasing sequence number for ordering (optional)
   */
  onStreamChunk(messageId: MessageID, chunk: string, sequence?: number): Promise<void>;

  /**
   * Called when streaming completes successfully
   *
   * IMPORTANT: Agent must still call messagesService.create() with full message after this!
   * This is just a signal to clean up streaming UI state.
   *
   * @param messageId - Message that finished streaming
   */
  onStreamEnd(messageId: MessageID): Promise<void>;

  /**
   * Called if streaming encounters an error
   *
   * @param messageId - Message that failed
   * @param error - Error that occurred
   */
  onStreamError(messageId: MessageID, error: Error): Promise<void>;

  /**
   * Called when thinking block streaming starts (optional)
   *
   * @param messageId - Message ID for the thinking block
   * @param metadata - Initial metadata (budget, etc.)
   */
  onThinkingStart?(
    messageId: MessageID,
    metadata: {
      budget?: number;
    }
  ): Promise<void>;

  /**
   * Called for each chunk of thinking content (optional)
   *
   * @param messageId - Message ID for the thinking block
   * @param chunk - Thinking text chunk
   */
  onThinkingChunk?(messageId: MessageID, chunk: string): Promise<void>;

  /**
   * Called when thinking block completes (optional)
   *
   * @param messageId - Message ID for the thinking block
   */
  onThinkingEnd?(messageId: MessageID): Promise<void>;
}

/**
 * Tool capabilities - feature flags for what each tool supports
 */
export interface ToolCapabilities {
  /** Can import historical sessions from tool's storage */
  supportsSessionImport: boolean;

  /** Can create new sessions via SDK/API */
  supportsSessionCreate: boolean;

  /** Can send prompts and receive responses */
  supportsLiveExecution: boolean;

  /** Can fork sessions at specific points */
  supportsSessionFork: boolean;

  /** Can spawn child sessions for subsessions */
  supportsChildSpawn: boolean;

  /** Tracks git state natively */
  supportsGitState: boolean;

  /**
   * Streams responses in real-time (optional UX enhancement)
   *
   * If true, tool will use StreamingCallbacks during executeTask() to provide
   * progressive updates. If false, tool will execute synchronously and return
   * complete message.
   *
   * All tools MUST call messagesService.create() with complete message regardless
   * of streaming support - streaming is purely optional progressive UX.
   */
  supportsStreaming: boolean;
}

/**
 * Options for importing sessions
 */
export interface ImportOptions {
  /** Project directory (for tools that organize by project) */
  projectDir?: string;

  /** Additional tool-specific options */
  [key: string]: unknown;
}

/**
 * Configuration for creating new sessions
 */
export interface CreateSessionConfig {
  /** Initial prompt to send */
  initialPrompt?: string;

  /** Working directory for the session */
  workingDirectory?: string;

  /** Git reference (branch/commit) to start from */
  gitRef?: string;

  /** Concepts to inject as context */
  concepts?: string[];

  /** Additional tool-specific config */
  [key: string]: unknown;
}

/**
 * Session handle - minimal identifier returned after creation/import
 */
export interface SessionHandle {
  sessionId: string;
  toolType: ToolType;
}

/**
 * Session data - rich data from import
 */
export interface SessionData extends SessionHandle {
  messages: Message[];
  metadata: SessionMetadata;
  workingDirectory?: string;
}

/**
 * Session metadata
 */
export interface SessionMetadata {
  sessionId: string;
  toolType: ToolType;
  status: 'active' | 'idle' | 'completed' | 'failed';
  createdAt: Date;
  lastUpdatedAt: Date;
  workingDirectory?: string;
  gitState?: {
    ref: string;
    baseSha: string;
    currentSha: string;
  };
  messageCount?: number;
  taskCount?: number;
}

/**
 * Task execution result
 */
export interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  messages: Message[];
  error?: Error;
  completedAt: Date;
}

/**
 * Message range for querying messages
 */
export interface MessageRange {
  startIndex?: number;
  endIndex?: number;
  limit?: number;
}
