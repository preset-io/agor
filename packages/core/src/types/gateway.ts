/**
 * Gateway Service Types
 *
 * Types for the gateway service that routes messages between
 * messaging platforms (Slack, Discord, etc.) and Agor sessions.
 */

import type { AgenticToolName, CodexApprovalPolicy, CodexSandboxMode } from './agentic-tool';
import type { SessionID, UserID, UUID, WorktreeID } from './id';
import type { PermissionMode } from './session';
import type { DefaultModelConfig } from './user';

// ============================================================================
// ID Types
// ============================================================================

/** Gateway channel identifier */
export type GatewayChannelID = UUID;

/** Thread-session mapping identifier */
export type ThreadSessionMapID = UUID;

// ============================================================================
// Enums
// ============================================================================

/** Supported messaging platform types */
export type ChannelType = 'slack' | 'discord' | 'whatsapp' | 'telegram';

/** Thread lifecycle status */
export type ThreadStatus = 'active' | 'archived' | 'paused';

// ============================================================================
// Agentic Tool Configuration
// ============================================================================

/**
 * Agentic tool configuration for gateway channels.
 *
 * Reuses existing types from agentic-tool.ts and user.ts to stay DRY.
 * When a channel has agentic_config, sessions created via that channel
 * use these settings. Falls back to user defaults when not set.
 */
export interface GatewayAgenticConfig {
  agent: AgenticToolName;
  modelConfig?: DefaultModelConfig;
  permissionMode?: PermissionMode;
  mcpServerIds?: string[];
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
}

// ============================================================================
// Core Interfaces
// ============================================================================

/**
 * Gateway Channel - A registered messaging platform integration
 *
 * Users create channels to connect messaging platforms (Slack, Discord, etc.)
 * to Agor. Each channel targets a specific worktree and routes messages
 * to/from sessions within that worktree.
 */
export interface GatewayChannel {
  id: GatewayChannelID;
  created_by: string;
  name: string;
  channel_type: ChannelType;
  target_worktree_id: WorktreeID;
  agor_user_id: UserID;
  channel_key: string; // UUID — the auth secret for inbound webhooks
  config: Record<string, unknown>; // Platform credentials (encrypted at rest)
  agentic_config: GatewayAgenticConfig | null; // Session creation settings
  enabled: boolean;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  last_message_at: string | null;
}

/**
 * Thread-Session Mapping - Links a platform thread to an Agor session
 *
 * Each thread in a messaging platform maps 1:1 to an Agor session.
 * The gateway service manages these mappings for routing.
 */
export interface ThreadSessionMap {
  id: ThreadSessionMapID;
  channel_id: GatewayChannelID;
  thread_id: string; // Platform-specific (e.g., "C123456-1707340800.123456")
  session_id: SessionID;
  worktree_id: WorktreeID;
  created_at: string;
  last_message_at: string;
  status: ThreadStatus;
  metadata: Record<string, unknown> | null;
}
