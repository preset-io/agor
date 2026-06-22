/**
 * Gateway Service Types
 *
 * Types for the gateway service that routes messages between
 * messaging platforms (Slack, Discord, etc.) and Agor sessions.
 */

import type { AgenticToolName, CodexApprovalPolicy, CodexSandboxMode } from './agentic-tool';
import type { BranchID, SessionID, TaskID, UserID, UUID } from './id';
import type { ScheduleID } from './schedule';
import type { PermissionMode } from './session';
import type { DefaultModelConfig } from './user';

// ============================================================================
// ID Types
// ============================================================================

/** Gateway channel identifier */
export type GatewayChannelID = UUID;

/** Thread-session mapping identifier */
export type ThreadSessionMapID = UUID;

/** Gateway outbound seed/audit message identifier */
export type GatewayOutboundMessageID = UUID;

// ============================================================================
// Enums
// ============================================================================

/** Supported messaging platform types */
export type ChannelType = 'slack' | 'discord' | 'whatsapp' | 'telegram' | 'github' | 'teams';

/** Thread lifecycle status */
export type ThreadStatus = 'active' | 'archived' | 'paused';

/** Sensitive gateway config fields that must be encrypted at rest and redacted in responses. */
export const GATEWAY_SENSITIVE_CONFIG_FIELDS = [
  'bot_token',
  'app_token',
  'signing_secret',
  'private_key',
  'webhook_secret',
  'app_password',
] as const;

/** Sentinel value used by gateway APIs/tools to represent a redacted secret. */
export const GATEWAY_REDACTED_SENTINEL = '••••••••';

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
/**
 * A single gateway-level environment variable with override behavior.
 *
 * - `forceOverride: false` (default) — fallback only; used when the user
 *   hasn't defined this key at the user level.
 * - `forceOverride: true` — always applied, even if the user has their own value.
 */
export interface GatewayEnvVar {
  key: string;
  value: string;
  forceOverride: boolean;
}

export interface GatewayAgenticConfig {
  agent: AgenticToolName;
  modelConfig?: DefaultModelConfig;
  permissionMode?: PermissionMode;
  mcpServerIds?: string[];
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
  /**
   * Gateway-level environment variables (e.g., service account tokens).
   *
   * Each entry specifies a key, value, and override mode:
   * - Fallback (`forceOverride: false`) — merged BEFORE user env vars so user
   *   values take precedence when both exist.
   * - Force override (`forceOverride: true`) — merged AFTER user env vars so
   *   the channel value always wins.
   */
  envVars?: GatewayEnvVar[];
}

// ============================================================================
// Core Interfaces
// ============================================================================

/**
 * Gateway Channel - A registered messaging platform integration
 *
 * Users create channels to connect messaging platforms (Slack, Discord, etc.)
 * to Agor. Each channel targets a specific branch and routes messages
 * to/from sessions within that branch.
 */
export interface GatewayChannel {
  id: GatewayChannelID;
  created_by: string;
  name: string;
  channel_type: ChannelType;
  target_branch_id: BranchID;
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
  branch_id: BranchID;
  created_at: string;
  last_message_at: string;
  status: ThreadStatus;
  metadata: Record<string, unknown> | null;
}

/**
 * Gateway outbound message - durable seed/audit record for proactive emits.
 *
 * These rows intentionally do not imply a thread-session mapping. The mapping is
 * created only when a human replies to the seeded external thread.
 */
export interface GatewayOutboundMessage {
  id: GatewayOutboundMessageID;
  gateway_channel_id: GatewayChannelID;
  channel_type: ChannelType;

  platform_channel_id: string;
  platform_message_id: string;
  platform_thread_id: string;
  platform_permalink: string | null;

  target_branch_id: BranchID;
  emitted_by_user_id: UserID;
  emitted_by_session_id: SessionID | null;
  emitted_by_task_id: TaskID | null;
  emitted_by_schedule_id: ScheduleID | null;

  message_text: string;
  message_preview: string;
  metadata: Record<string, unknown> | null;
  consumed_by_session_id: SessionID | null;
  consumed_at: string | null;

  created_at: string;
  updated_at: string;
}
