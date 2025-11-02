/**
 * Message Type
 *
 * Represents a single message in a conversation between user and agent.
 * Messages are stored in a normalized table and referenced by tasks via message_range.
 */

import type { MessageID, SessionID, TaskID } from './id';

/**
 * Message role - who is speaking
 */
export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

/**
 * Message type (from Claude transcript)
 * Distinguishes conversation messages from meta/snapshot messages
 */
export type MessageType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'file-history-snapshot'
  | 'permission_request';

/**
 * Content block (for multi-modal messages)
 */
export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking' | 'system_status';
  [key: string]: unknown; // Additional type-specific fields
}

/**
 * Tool use in a message
 */
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Permission scope - how long a permission grant lasts
 */
export enum PermissionScope {
  ONCE = 'once', // Just this one request
  SESSION = 'session', // For this session
  PROJECT = 'project', // For this entire project
}

/**
 * Permission request status
 */
export enum PermissionStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  DENIED = 'denied',
}

/**
 * Permission request content
 * Used when type === 'permission_request'
 */
export interface PermissionRequestContent {
  request_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  status: PermissionStatus;
  scope?: PermissionScope; // Set when approved
  approved_by?: string; // User ID who approved/denied
  approved_at?: string; // Timestamp of decision
}

/**
 * Message
 *
 * Represents a single turn in the conversation.
 */
export interface Message {
  /** Unique message identifier (UUIDv7) */
  message_id: MessageID;

  /** Session this message belongs to */
  session_id: SessionID;

  /** Task this message belongs to (optional - messages may exist before task assignment) */
  task_id?: TaskID;

  /** Message type (from transcript) */
  type: MessageType;

  /** Message role */
  role: MessageRole;

  /** Index in conversation (0-based, used for message_range queries) */
  index: number;

  /** When message was created */
  timestamp: string;

  /** Content preview (first 200 chars for list views) */
  content_preview: string;

  /** Full message content (type depends on message type) */
  content: string | ContentBlock[] | PermissionRequestContent;

  /** Tool uses in this message (for assistant messages) */
  tool_uses?: ToolUse[];

  /**
   * Parent tool use ID (from Claude Agent SDK)
   * When a tool spawns nested operations (e.g., Task tool spawning Read/Grep),
   * child operations have this set to the parent tool's ID.
   * This enables grouping nested tool calls under their parent in the UI.
   */
  parent_tool_use_id?: string | null;

  /** Agent-specific metadata */
  metadata?: {
    /** Model used for this message */
    model?: string;

    /** Token counts */
    tokens?: {
      input: number;
      output: number;
    };

    /** Original agent message ID (e.g., Claude's UUID) */
    original_id?: string;

    /** Parent message ID in agent's system */
    parent_id?: string;

    /** Whether this is a meta/synthetic message */
    is_meta?: boolean;

    /** Additional agent-specific fields */
    [key: string]: unknown;
  };
}

/**
 * Message creation input (without generated fields)
 */
export type MessageCreate = Omit<Message, 'message_id'> & {
  message_id?: MessageID;
};
