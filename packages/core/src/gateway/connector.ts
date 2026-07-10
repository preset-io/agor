/**
 * Gateway Connector Interface
 *
 * Defines the contract for platform-specific connectors that handle
 * sending messages to and receiving messages from messaging platforms.
 */

import type { ChannelType, SlackTestResult } from '../types/gateway';

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
  threadId: string;
  text: string;
  userId: string;
  timestamp: string;
  files?: InboundFile[];
  metadata?: Record<string, unknown>;
}

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
  startListening?(callback: (msg: InboundMessage) => void): Promise<void>;

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
  testConnection?(): Promise<SlackTestResult>;
}
