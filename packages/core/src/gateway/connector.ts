/**
 * Gateway Connector Interface
 *
 * Defines the contract for platform-specific connectors that handle
 * sending messages to and receiving messages from messaging platforms.
 */

import type { ChannelType } from '../types/gateway';

/**
 * Inbound message from a messaging platform
 */
export interface InboundMessage {
  threadId: string;
  text: string;
  userId: string;
  timestamp: string;
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
}
