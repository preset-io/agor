/**
 * Slack Connector
 *
 * Sends messages via Slack Web API and optionally listens for
 * inbound messages via Socket Mode.
 *
 * Config shape (stored encrypted in gateway_channels.config):
 *   { bot_token: string, app_token?: string, default_channel?: string }
 *
 * Thread ID format: "{channel_id}-{thread_ts}"
 *   e.g. "C07ABC123-1707340800.123456"
 */

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';

import type { ChannelType } from '../../types/gateway';
import type { GatewayConnector, InboundMessage } from '../connector';

interface SlackConfig {
  bot_token: string;
  app_token?: string;
  default_channel?: string;
}

/**
 * Parse a composite thread ID into Slack channel + thread_ts
 *
 * Format: "{channel_id}-{thread_ts}" where thread_ts contains a dot
 * e.g. "C07ABC123-1707340800.123456" → { channel: "C07ABC123", thread_ts: "1707340800.123456" }
 */
function parseThreadId(threadId: string): { channel: string; thread_ts: string } {
  // thread_ts always contains a dot, so split on the last hyphen before the numeric part
  const lastHyphen = threadId.lastIndexOf('-');
  if (lastHyphen === -1) {
    throw new Error(
      `Invalid Slack thread ID format: "${threadId}" (expected "{channel}-{thread_ts}")`
    );
  }

  const channel = threadId.substring(0, lastHyphen);
  const thread_ts = threadId.substring(lastHyphen + 1);

  if (!channel || !thread_ts) {
    throw new Error(
      `Invalid Slack thread ID format: "${threadId}" (expected "{channel}-{thread_ts}")`
    );
  }

  return { channel, thread_ts };
}

/**
 * Convert markdown to Slack mrkdwn format
 *
 * Handles basic conversions:
 * - **bold** → *bold*
 * - _italic_ stays as _italic_
 * - ```code blocks``` stay as-is (Slack supports triple backtick)
 * - `inline code` stays as-is
 * - [text](url) → <url|text>
 */
function markdownToMrkdwn(markdown: string): string {
  return (
    markdown
      // Bold: **text** → *text*
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // Links: [text](url) → <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
  );
}

export class SlackConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'slack';

  private web: WebClient;
  private socketMode: SocketModeClient | null = null;
  private config: SlackConfig;

  constructor(config: Record<string, unknown>) {
    this.config = config as unknown as SlackConfig;

    if (!this.config.bot_token) {
      throw new Error('Slack connector requires bot_token in config');
    }

    this.web = new WebClient(this.config.bot_token);
  }

  /**
   * Send a message to a Slack thread
   */
  async sendMessage(req: {
    threadId: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const { channel, thread_ts } = parseThreadId(req.threadId);

    const result = await this.web.chat.postMessage({
      channel,
      thread_ts,
      text: this.formatMessage(req.text),
      unfurl_links: false,
      unfurl_media: false,
    });

    if (!result.ok || !result.ts) {
      throw new Error(`Slack API error: ${result.error ?? 'unknown error'}`);
    }

    return result.ts;
  }

  /**
   * Start listening for inbound messages via Socket Mode
   *
   * Requires app_token in config. Filters for messages that
   * mention the bot or are direct messages.
   */
  async startListening(callback: (msg: InboundMessage) => void): Promise<void> {
    if (!this.config.app_token) {
      throw new Error('Slack Socket Mode requires app_token in config');
    }

    this.socketMode = new SocketModeClient({
      appToken: this.config.app_token,
    });

    // Debug: log all incoming Slack events
    this.socketMode.on('slack_event', async ({ type, body, ack }) => {
      console.log(`[slack] Received event type="${type}" subtype="${body?.event?.type}"`);

      // Only handle events_api message events
      if (type !== 'events_api' || body?.event?.type !== 'message') {
        await ack();
        return;
      }

      await ack();
      const event = body.event;

      // Only handle DMs (im) — skip public/private channel messages
      if (event.channel_type && event.channel_type !== 'im') {
        console.log(`[slack] Skipping non-DM message (channel_type=${event.channel_type})`);
        return;
      }

      // Skip bot messages to avoid loops
      if (event.bot_id || event.subtype === 'bot_message') {
        console.log('[slack] Skipping bot message');
        return;
      }

      // Skip message edits, deletes, and other subtypes — only handle new messages
      if (event.subtype) {
        console.log(`[slack] Skipping message subtype="${event.subtype}"`);
        return;
      }

      const threadId = event.thread_ts
        ? `${event.channel}-${event.thread_ts}`
        : `${event.channel}-${event.ts}`;

      console.log(
        `[slack] Inbound message: thread=${threadId} user=${event.user} text="${event.text?.substring(0, 50)}"`
      );

      callback({
        threadId,
        text: event.text ?? '',
        userId: event.user ?? 'unknown',
        timestamp: event.ts ?? new Date().toISOString(),
        metadata: {
          channel: event.channel,
          channel_type: event.channel_type,
        },
      });
    });

    await this.socketMode.start();
  }

  /**
   * Stop Socket Mode listener
   */
  async stopListening(): Promise<void> {
    if (this.socketMode) {
      await this.socketMode.disconnect();
      this.socketMode = null;
    }
  }

  /**
   * Convert markdown to Slack mrkdwn
   */
  formatMessage(markdown: string): string {
    return markdownToMrkdwn(markdown);
  }
}
