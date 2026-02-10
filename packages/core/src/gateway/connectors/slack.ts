/**
 * Slack Connector
 *
 * Sends messages via Slack Web API and optionally listens for
 * inbound messages via Socket Mode.
 *
 * Config shape (stored encrypted in gateway_channels.config):
 *   {
 *     bot_token: string,
 *     app_token?: string,
 *     default_channel?: string,
 *     enable_channels?: boolean,      // Listen in public channels
 *     enable_groups?: boolean,        // Listen in private channels
 *     enable_mpim?: boolean,          // Listen in group DMs
 *     require_mention?: boolean,      // Require @mention in channels
 *     allowed_channel_ids?: string[]  // Channel ID whitelist
 *   }
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

  // Message source configuration
  enable_channels?: boolean;
  enable_groups?: boolean;
  enable_mpim?: boolean;
  require_mention?: boolean;
  allowed_channel_ids?: string[];
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
  private botUserId: string | null = null;

  constructor(config: Record<string, unknown>) {
    this.config = config as unknown as SlackConfig;

    if (!this.config.bot_token) {
      throw new Error('Slack connector requires bot_token in config');
    }

    // Debug: Log token status (not the actual token!)
    console.log('[slack] Initializing connector');
    console.log('[slack] bot_token present:', !!this.config.bot_token);
    console.log('[slack] bot_token starts with xoxb:', this.config.bot_token?.startsWith('xoxb-'));
    console.log('[slack] bot_token length:', this.config.bot_token?.length);
    console.log('[slack] app_token present:', !!this.config.app_token);
    console.log('[slack] app_token starts with xapp:', this.config.app_token?.startsWith('xapp-'));

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
    console.log(`[slack] sendMessage called with threadId: ${req.threadId}`);
    const { channel, thread_ts } = parseThreadId(req.threadId);
    console.log(`[slack] Parsed - channel: ${channel}, thread_ts: ${thread_ts}`);

    const result = await this.web.chat.postMessage({
      channel,
      thread_ts,
      text: this.formatMessage(req.text),
      unfurl_links: false,
      unfurl_media: false,
    });

    if (!result.ok || !result.ts) {
      console.error(`[slack] Message send failed: ${result.error}`);
      throw new Error(`Slack API error: ${result.error ?? 'unknown error'}`);
    }

    console.log(`[slack] Message sent successfully to thread ${thread_ts} in channel ${channel}`);
    return result.ts;
  }

  /**
   * Start listening for inbound messages via Socket Mode
   *
   * Requires app_token in config. Filters messages based on config:
   * - Direct messages (always enabled)
   * - Public channels (if enable_channels = true)
   * - Private channels (if enable_groups = true)
   * - Group DMs (if enable_mpim = true)
   * - Mention requirement (if require_mention = true)
   * - Channel whitelist (if allowed_channel_ids is set)
   */
  async startListening(callback: (msg: InboundMessage) => void): Promise<void> {
    console.log('[slack] startListening called');

    if (!this.config.app_token) {
      console.error('[slack] ERROR: app_token is missing from config');
      throw new Error('Slack Socket Mode requires app_token in config');
    }

    console.log('[slack] Creating SocketModeClient...');
    this.socketMode = new SocketModeClient({
      appToken: this.config.app_token,
    });

    // Fetch bot user ID for mention detection
    let botMentionPattern: RegExp | null = null;
    let botMentionReplacePattern: RegExp | null = null;
    try {
      console.log('[slack] Testing bot token with auth.test()...');
      const authTest = await this.web.auth.test();
      this.botUserId = authTest.user_id as string;
      // Precompile regex patterns for performance
      botMentionPattern = new RegExp(`<@${this.botUserId}>`);
      botMentionReplacePattern = new RegExp(`<@${this.botUserId}>\\s*`, 'g');
      console.log(`[slack] Bot user ID: ${this.botUserId}`);
      console.log(
        `[slack] Bot auth test successful - team: ${authTest.team}, user: ${authTest.user}`
      );
    } catch (error) {
      console.error('[slack] Failed to fetch bot user ID:', error);
      console.error('[slack] This usually means the bot_token is invalid or expired');
      console.warn('[slack] Mention detection will be disabled');
    }

    // Read config options (with defaults matching UI)
    const enableChannels = this.config.enable_channels ?? false;
    const enableGroups = this.config.enable_groups ?? false;
    const enableMpim = this.config.enable_mpim ?? false;
    const requireMention = this.config.require_mention ?? true;

    // Normalize allowed_channel_ids to string[] (handle malformed config)
    let allowedChannelIds: string[] | undefined;
    if (this.config.allowed_channel_ids) {
      if (Array.isArray(this.config.allowed_channel_ids)) {
        allowedChannelIds = this.config.allowed_channel_ids.filter(
          (id): id is string => typeof id === 'string'
        );
      } else if (typeof this.config.allowed_channel_ids === 'string') {
        // Handle case where config was persisted as string instead of array
        allowedChannelIds = [this.config.allowed_channel_ids];
      } else {
        console.warn(
          '[slack] Invalid allowed_channel_ids config (not array or string). Ignoring whitelist.'
        );
        allowedChannelIds = undefined;
      }
    }

    console.log('[slack] Message source config:', {
      enableChannels,
      enableGroups,
      enableMpim,
      requireMention,
      allowedChannelIds: allowedChannelIds?.length || 0,
    });

    // Handle incoming Slack events
    this.socketMode.on('slack_event', async ({ type, body, ack }) => {
      console.log(`[slack] Received event type="${type}" subtype="${body?.event?.type}"`);
      console.log(`[slack] Event details:`, JSON.stringify(body?.event, null, 2).substring(0, 500));

      // Handle both 'message' events (DMs, threads) and 'app_mention' events (channel mentions)
      if (type !== 'events_api') {
        console.log(`[slack] Ignoring non-events_api event`);
        await ack();
        return;
      }

      const eventType = body?.event?.type;
      if (eventType !== 'message' && eventType !== 'app_mention') {
        console.log(`[slack] Ignoring event type="${eventType}"`);
        await ack();
        return;
      }

      await ack();
      const event = body.event;
      console.log(
        `[slack] Processing ${eventType} event - channel: ${event.channel}, channel_type: ${event.channel_type}`
      );

      // Skip bot messages to avoid loops
      if (event.bot_id || event.subtype === 'bot_message') {
        console.log('[slack] Skipping bot message');
        return;
      }

      // Skip message edits, deletes, and other subtypes — only handle new messages
      // Note: app_mention events don't have subtypes
      if (eventType === 'message' && event.subtype) {
        console.log(`[slack] Skipping message subtype="${event.subtype}"`);
        return;
      }

      // IMPORTANT: Prevent duplicate processing
      // When a bot is mentioned in a channel, Slack sends BOTH:
      // 1. 'app_mention' event (we want this for channels)
      // 2. 'message' event (we want this for DMs and thread replies)
      //
      // Strategy:
      // - Use 'app_mention' for channel mentions (new conversations in channels)
      // - Use 'message' for DMs and thread replies
      // - Skip 'message' events that are mentions in channels (to avoid duplicates)
      const isThreadReply = !!event.thread_ts;
      const isChannelMessage = event.channel_type === 'channel' || event.channel_type === 'group';

      if (eventType === 'message' && isChannelMessage && !isThreadReply) {
        // This is a top-level channel message - check if it's a mention
        // If it's a mention, we'll handle it via app_mention event instead
        const hasMention = botMentionPattern?.test(event.text ?? '');
        if (hasMention) {
          console.log(
            '[slack] Skipping message event with mention (will be handled by app_mention)'
          );
          return;
        }
      }

      const channelType = event.channel_type;

      // Handle missing channel_type (some Slack events may omit it)
      if (!channelType) {
        console.warn(
          `[slack] Message event missing channel_type for channel ${event.channel}. Treating as DM (safest default).`
        );
        // Treat as DM - safest default since DMs are always allowed
        // If this causes issues, we could instead infer from channel ID prefix
      }

      // Channel type filtering based on config
      if (!channelType || channelType === 'im') {
        // Direct messages are always allowed
        console.log('[slack] Processing DM (always allowed)');
      } else if (channelType === 'channel') {
        if (!enableChannels) {
          console.log('[slack] Skipping public channel message (not enabled in config)');
          return;
        }
        console.log('[slack] Processing public channel message (enabled in config)');
      } else if (channelType === 'group') {
        if (!enableGroups) {
          console.log('[slack] Skipping private channel message (not enabled in config)');
          return;
        }
        console.log('[slack] Processing private channel message (enabled in config)');
      } else if (channelType === 'mpim') {
        if (!enableMpim) {
          console.log('[slack] Skipping group DM (not enabled in config)');
          return;
        }
        console.log('[slack] Processing group DM (enabled in config)');
      } else {
        console.log(`[slack] Skipping unknown channel_type="${channelType}"`);
        return;
      }

      // Channel whitelist check (applies to all channel types)
      if (allowedChannelIds && allowedChannelIds.length > 0) {
        if (!allowedChannelIds.includes(event.channel)) {
          console.log(
            `[slack] Skipping message from non-whitelisted channel ${event.channel} (whitelist: ${allowedChannelIds.join(', ')})`
          );
          return;
        }
        console.log(`[slack] Channel ${event.channel} is whitelisted`);
      }

      // Mention requirement for new conversations (not for thread replies)
      let messageText = event.text ?? '';

      if (requireMention && !isThreadReply) {
        // Only require mention for NEW conversations, not for replies in existing threads
        console.log('[slack] Checking mention requirement for new conversation');
        if (!botMentionPattern || !botMentionReplacePattern) {
          // SECURITY: Fail closed - if we can't verify mentions, reject messages
          console.warn(
            '[slack] Cannot enforce mention requirement (bot user ID not available). Rejecting message for safety.'
          );
          return;
        }
        if (!botMentionPattern.test(messageText)) {
          console.log('[slack] Skipping message without bot mention');
          return;
        }
        // Strip bot mention from text before processing
        messageText = messageText.replace(botMentionReplacePattern, '').trim();
        console.log('[slack] Bot was mentioned, stripped mention from text');
      } else if (isThreadReply) {
        // For thread replies, still strip mention if present, but don't require it
        console.log('[slack] Thread reply - bypassing mention requirement');
        if (botMentionReplacePattern?.test(messageText)) {
          messageText = messageText.replace(botMentionReplacePattern, '').trim();
          console.log('[slack] Stripped optional mention from thread reply');
        }
      }

      const threadId = event.thread_ts
        ? `${event.channel}-${event.thread_ts}`
        : `${event.channel}-${event.ts}`;

      console.log(
        `[slack] Inbound message: thread=${threadId} channel_type=${channelType} user=${event.user} text="${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`
      );

      callback({
        threadId,
        text: messageText,
        userId: event.user ?? 'unknown',
        timestamp: event.ts ?? new Date().toISOString(),
        metadata: {
          channel: event.channel,
          channel_type: event.channel_type,
        },
      });
    });

    console.log('[slack] Starting Socket Mode client...');
    await this.socketMode.start();
    console.log('[slack] Socket Mode client connected successfully!');
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
