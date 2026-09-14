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
 * `url_private_download` is a platform URL that requires the channel's
 * credentials to fetch; connectors pass it through verbatim and the gateway
 * decides whether/how to download it.
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
  prepareDelivery?: (
    context?: InboundPreparationContext
  ) => Promise<Record<string, unknown> | undefined>;
}

/** Narrow listener-owned hint for provider acknowledgement preparation. */
export interface InboundPreparationContext {
  /** A durable proactive seed owns this top-level message; do not materialize a summon thread. */
  skipProviderThreadMaterialization?: boolean;
}

/**
 * One message returned by an optional provider-history capability.
 *
 * History is an ephemeral ingest boundary: connectors must not persist or log
 * these values. The daemon decides which messages are safe to put in a Task
 * prompt after applying its provider-neutral policy.
 */
export interface GatewayProviderHistoryMessage {
  providerMessageId: string;
  timestamp: string;
  actorLabel: string;
  text: string;
  isBot: boolean;
  isSystem: boolean;
  isRich: boolean;
  isTrigger: boolean;
  isMention: boolean;
}

/** Request for one bounded, exclusive/inclusive provider-history interval. */
export interface GatewayProviderHistoryRequest {
  threadId: string;
  /** The lower bound is exclusive. Omit only for a verified bootstrap. */
  afterProviderCursor?: string;
  /** The live mention boundary is inclusive. */
  throughProviderCursor: string;
  triggerProviderCursor: string;
}

/** A complete, ordered provider-history interval. */
export interface GatewayProviderHistoryResult {
  threadId: string;
  messages: GatewayProviderHistoryMessage[];
  /** False means the connector could not prove complete interval coverage. */
  complete: boolean;
}

/** Durable provider polling checkpoint owned by the current listener lease. */
export interface GatewayListenerOptions {
  checkpoint?: Record<string, unknown> | null;
  /** The gateway durably deduplicates stable provider event identities. */
  durableEventIdempotency?: boolean;
  /** False means the listener lost its durable owner fence and must stop. */
  saveCheckpoint?: (checkpoint: Record<string, unknown>) => Promise<boolean>;
  /** Called after a running listener stops because ordered processing failed. */
  onError?: (error: unknown) => void | Promise<void>;
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

/** Provider-neutral receipt returned by connectors after one or more sends. */
export interface GatewaySendReceipt {
  /** The last provider message id in this send operation. */
  messageId: string;
  /** All provider message ids when the connector chunked the response. */
  messageIds?: string[];
  /** Canonical provider thread id used for subsequent sends. */
  threadId?: string;
  /** Generic inbound aliases that should resolve to the same thread-session map. */
  replyAliases?: string[];
  platformChannelId?: string;
  platformThreadId?: string;
  permalink?: string | null;
  /** Provider-specific non-secret details useful to the audit row. */
  metadata?: Record<string, unknown>;
}

export type GatewaySendResult = string | GatewaySendReceipt;

/** Normalize legacy string receipts and structured connector receipts. */
export function normalizeSendReceipt(result: GatewaySendResult): GatewaySendReceipt {
  return typeof result === 'string' ? { messageId: result } : result;
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

  /**
   * Send a message to a platform thread.
   *
   * `blocks` is optional and platform-specific. Connectors that don't support
   * structured blocks should ignore it and use `text`.
   *
   * @returns A legacy platform message ID or a structured receipt.
   */
  sendMessage(req: {
    threadId: string;
    text: string;
    blocks?: unknown[];
    metadata?: Record<string, unknown>;
  }): Promise<GatewaySendResult>;

  /**
   * Best-effort reconciliation for an ambiguous at-least-once post. Providers
   * that expose durable message metadata may return the matching message id;
   * absence is not proof that a previous post did not land.
   */
  findMessageByMetadata?(req: {
    threadId: string;
    eventType: string;
    payloadKey: string;
    payloadValue: string;
    limit?: number;
  }): Promise<string | undefined>;

  /**
   * Optional bounded history read used by mention catch-up. The returned
   * interval is provider-neutral, ordered oldest-first, and remains in memory
   * until the daemon formats the single admitted Task prompt.
   */
  fetchProviderHistory?(req: GatewayProviderHistoryRequest): Promise<GatewayProviderHistoryResult>;

  /**
   * Send directly to a provider target without an existing thread mapping.
   * GatewayService owns authorization, audit, and outbound seed persistence;
   * the connector owns provider target parsing/resolution and transport.
   */
  sendDirectMessage?(req: {
    target: string;
    text: string;
    blocks?: unknown[];
    threadId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<GatewaySendResult>;

  /** Recover one provider message after an ambiguous nonce-protected send. */
  recoverMessageByNonce?(req: {
    threadId: string;
    nonce: string;
  }): Promise<GatewaySendReceipt | null>;

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
  testConnection?(): Promise<GatewayConnectionTestResult>;

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
