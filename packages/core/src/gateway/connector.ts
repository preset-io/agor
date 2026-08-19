/**
 * Gateway Connector Interface
 *
 * Defines the contract for platform-specific connectors that handle
 * sending messages to and receiving messages from messaging platforms.
 */

import type {
  ChannelType,
  GatewayConnectionTestResult,
  GatewayEnvVar,
  SlackAppInfo,
} from '../types/gateway';

/**
 * File attached to an inbound message (provider-neutral shape).
 *
 * `url_private_download` is an ephemeral provider URL. It requires channel
 * credentials for Slack and must be fetched without credentials for Discord;
 * connectors pass it only for explicitly configured admitted messages and the
 * gateway applies the provider-specific download policy.
 */
export interface InboundFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download: string;
}

/**
 * Inbound message from a messaging platform
 */
export interface InboundMessage {
  /** Stable provider delivery identity used for durable idempotency. */
  providerEventId?: string;
  threadId: string;
  text: string;
  userId: string;
  timestamp: string;
  files?: InboundFile[];
  metadata?: Record<string, unknown>;
  /**
   * Optional provider acknowledgement prepared only after Agor durably wins
   * the event occurrence. The returned metadata is merged into the inbound
   * message (for example an editable acknowledgement comment ID).
   */
  prepareDelivery?: () => Promise<Record<string, unknown> | undefined>;
}

/** Provider-neutral, agent-visible history item used for summon-time catch-up. */
export interface GatewayHistoryMessage {
  cursor: string;
  iso_time: string;
  actor_label: string;
  text: string;
  is_trigger: boolean;
  /** Metadata-only summary; ambient history attachments are never downloaded. */
  attachment_summary?: string;
}

export interface GatewayHistoryCapability {
  fetchConversationHistory(req: {
    threadId: string;
    afterCursor?: string;
    throughCursor: string;
    triggerCursor: string;
    limit: number;
    includeBotMessages: false;
    /**
     * Summon-time context may return the newest bounded window when the lower
     * cursor is farther back than the provider scan bound. The result must set
     * has_more instead of pretending the interval was complete. Read tools do
     * not set this and continue to fail closed on an incomplete scan.
     */
    allowTruncatedLowerBound?: true;
    /** Prefer the messages nearest the current summon when truncation occurs. */
    preferLatest?: true;
    /** Exact owner/action fence invoked immediately before every provider GET. */
    beforeProviderCall?: () => Promise<void>;
  }): Promise<{ messages: GatewayHistoryMessage[]; has_more: boolean; next_cursor?: string }>;
  /** Provider-owned cursor ordering (Slack timestamps, Discord Snowflakes, etc.). */
  compareCursors(a: string, b?: string): number;
}

/** Process-local, content-free aggregate presence health. */
export interface GatewayAggregatePresenceDiagnostic {
  desiredActiveCount: number | null;
  lastSentActiveCount: number | null;
  pending: boolean;
  retryCount: number;
  lastErrorCode?: 'discord_presence_send_failed' | 'discord_presence_owner_lost';
}

/** Durable provider polling checkpoint owned by the current listener lease. */
export interface GatewayListenerOptions {
  checkpoint?: Record<string, unknown> | null;
  /** The gateway durably deduplicates stable provider event identities. */
  durableEventIdempotency?: boolean;
  /** False means the listener lost its durable owner fence and must stop. */
  saveCheckpoint?: (checkpoint: Record<string, unknown>) => Promise<boolean>;
  /** Current-fence assertion around owned provider work. */
  listenerClaimIsCurrent?: () => Promise<boolean>;
  /** Receives content-free aggregate presence state for owner diagnostics. */
  reportAggregatePresenceState?: (state: GatewayAggregatePresenceDiagnostic) => void;
}

export type GatewayInboundCallback = (msg: InboundMessage) => void | Promise<void>;

/**
 * Outbound payload for a single message.
 *
 * `text` is always populated and acts as the plain/fallback rendering
 * (used by client notifications and platforms that ignore structured blocks).
 * `blocks` is platform-specific (e.g. Slack Block Kit) and is opaque here;
 * the receiving connector knows how to interpret it.
 */
export interface OutboundPayload {
  text: string;
  blocks?: unknown[];
}

/**
 * Normalize the value returned by a connector's `formatMessage` (which may
 * be a plain mrkdwn/markdown string or a structured {@link OutboundPayload})
 * into a canonical `OutboundPayload` shape, so callers don't have to branch.
 */
export function normalizeOutbound(formatted: string | OutboundPayload): OutboundPayload {
  return typeof formatted === 'string' ? { text: formatted } : formatted;
}

/**
 * Gateway connector — abstracts platform-specific messaging APIs
 *
 * Each connector handles one channel type (Slack, Discord, etc.) and provides
 * methods to send messages outbound and optionally listen for inbound messages.
 */
export interface GatewayConnector {
  readonly channelType: ChannelType;

  /** Optional bounded current-conversation history for summon-time catch-up. */
  readonly history?: GatewayHistoryCapability;

  /**
   * Send a message to a platform thread.
   *
   * `blocks` is optional and platform-specific. Connectors that don't support
   * structured blocks should ignore it and use `text`.
   *
   * @returns Platform-specific message ID
   */
  sendMessage(req: {
    threadId: string;
    text: string;
    blocks?: unknown[];
    metadata?: Record<string, unknown>;
  }): Promise<string>;

  /**
   * Delete a previously sent platform message when supported.
   *
   * Used for temporary UX affordances (for example, Slack progress rows) that
   * should disappear once the durable assistant response has arrived.
   */
  deleteMessage?(req: { threadId: string; messageId: string }): Promise<void>;

  /**
   * Set platform-native thread status when supported.
   *
   * Slack exposes this via assistant.threads.setStatus; unlike a mutable chat
   * message, the status is rendered by Slack as assistant chrome.
   */
  setThreadStatus?(req: {
    threadId: string;
    status: string;
    loadingMessages?: string[];
    iconEmoji?: string;
  }): Promise<void>;

  /**
   * Start listening for inbound messages (e.g., via Socket Mode or webhooks)
   */
  startListening?(
    callback: GatewayInboundCallback,
    options?: GatewayListenerOptions
  ): Promise<void>;

  /**
   * Stop listening for inbound messages
   */
  stopListening?(): Promise<void>;

  /** Best-effort aggregate application presence through an owned transport. */
  updateAggregatePresence?(activeCount: number): void;

  /** Content-free process-local aggregate presence health. */
  getAggregatePresenceDiagnostic?(): GatewayAggregatePresenceDiagnostic;

  /**
   * Convert markdown to platform-native formatting.
   *
   * May return a plain string (mrkdwn/markdown text) or a richer
   * {@link OutboundPayload} including structured `blocks` that the connector's
   * own `sendMessage` will interpret. Callers should accept either shape.
   */
  formatMessage?(markdown: string): string | OutboundPayload;

  /**
   * Best-effort probe of the connector's credentials and reachability.
   *
   * Implementations exercise real platform API calls to verify what they can
   * (token validity, Socket Mode handshake, sampled channel access) and return
   * a structured report. `result.notVerifiable` lists what the probe cannot
   * prove, so a green result is never mistaken for full verification.
   */
  testConnection?(options?: { signal?: AbortSignal }): Promise<GatewayConnectionTestResult>;

  /**
   * Environment variables the connector's platform skills need inside a
   * gateway-created session — e.g. an API token + base URL so the agent can
   * fetch the platform's attachments (Shortcut media-intake reads
   * `SHORTCUT_API_TOKEN`). The daemon merges these into the session env at
   * spawn; operator-set `agentic_config.envVars` take precedence, so a
   * connector should return safe service defaults.
   */
  sessionEnv?(): GatewayEnvVar[];

  /**
   * Best-effort resolution of the platform app behind the channel's stored
   * credentials (e.g. Slack app id via `auth.test` → `bots.info`), so the UI
   * can deep-link to the app's settings. Returns nulls on failure rather than
   * throwing, and never includes token material.
   */
  getAppInfo?(): Promise<SlackAppInfo>;
}
