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
 * Gateway connector — abstracts platform-specific messaging APIs
 *
 * Each connector handles one channel type (Slack, Discord, etc.) and provides
 * methods to send messages outbound and optionally listen for inbound messages.
 */
export interface GatewayConnector {
  readonly channelType: ChannelType;

  /**
   * Send a message to a platform thread
   * @returns Platform-specific message ID
   */
  sendMessage(req: {
    threadId: string;
    text: string;
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
   * Convert markdown to platform-native formatting
   */
  formatMessage?(markdown: string): string;
}
