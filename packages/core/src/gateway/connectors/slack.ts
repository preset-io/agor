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
 *     enable_channels?: boolean,                    // Listen in public channels
 *     enable_groups?: boolean,                      // Listen in private channels
 *     enable_mpim?: boolean,                        // Listen in group DMs
 *     require_mention?: boolean,                    // Require @mention in channels
 *     allow_thread_replies_without_mention?: boolean, // Allow thread replies without @mention (default: true)
 *     allowed_channel_ids?: string[]                // Channel ID whitelist
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
  allow_thread_replies_without_mention?: boolean;
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
    // Initialization - tokens validated during startListening

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
      console.error(`[slack] Message send failed: ${result.error}`);
      throw new Error(`Slack API error: ${result.error ?? 'unknown error'}`);
    }

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
    const allowThreadRepliesWithoutMention =
      this.config.allow_thread_replies_without_mention ?? false;

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
      // Event received - process based on type

      // Handle both 'message' events (DMs, threads) and 'app_mention' events (channel mentions)
      if (type !== 'events_api') {
        await ack();
        return;
      }

      const eventType = body?.event?.type;
      if (eventType !== 'message' && eventType !== 'app_mention') {
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
        return;
      }

      // IMPORTANT: Prevent duplicate processing
      // When a bot is mentioned, Slack sends BOTH 'app_mention' and 'message' events.
      // This happens for top-level messages AND thread replies.
      //
      // Strategy:
      // - Use 'app_mention' for ALL mentions (top-level AND threads)
      // - Use 'message' for DMs and non-mention messages
      // - Skip 'message' events that have mentions (to avoid duplicates)
      const isThreadReply = !!event.thread_ts;
      const isChannelMessage = event.channel_type === 'channel' || event.channel_type === 'group';

      // CRITICAL: Prevent duplicates in channels/groups when bot ID unavailable
      // Strategy depends on require_mention setting:
      // - If require_mention=true: prefer app_mention (Slack guarantees mention), skip message
      // - If require_mention=false: prefer message (app_mention won't fire for non-mentions), skip app_mention
      if (isChannelMessage && !botMentionPattern) {
        if (eventType === 'message' && requireMention) {
          // Can't detect mentions - let app_mention handle (which Slack guarantees is a mention)
          console.warn(
            '[slack] Bot ID unavailable, require_mention=true - skipping message event (will use app_mention)'
          );
          return;
        }
        if (eventType === 'app_mention' && !requireMention) {
          // Avoid duplicates - prefer message events when mentions not required
          console.warn(
            '[slack] Bot ID unavailable, require_mention=false - skipping app_mention (will use message)'
          );
          return;
        }
      }

      if (eventType === 'message' && isChannelMessage && botMentionPattern) {
        // For all channel/group messages (including threads), check if it's a mention
        // If it's a mention, we'll handle it via app_mention event instead
        const hasMention = botMentionPattern.test(event.text ?? '');
        if (hasMention) {
          return; // Will be handled by app_mention event
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
      } else if (channelType === 'channel' && !enableChannels) {
        return; // Public channels not enabled
      } else if (channelType === 'group' && !enableGroups) {
        return; // Private channels not enabled
      } else if (channelType === 'mpim' && !enableMpim) {
        return; // Group DMs not enabled
      } else if (
        channelType !== 'im' &&
        channelType !== 'channel' &&
        channelType !== 'group' &&
        channelType !== 'mpim'
      ) {
        console.warn(`[slack] Unknown channel_type="${channelType}"`);
        return;
      }

      // Channel whitelist check (applies to all channel types)
      if (allowedChannelIds && allowedChannelIds.length > 0) {
        if (!allowedChannelIds.includes(event.channel)) {
          return; // Not in whitelist
        }
      }

      // Mention requirement handling
      let messageText = event.text ?? '';
      let hasMention = false;
      let allowedViaThreadReplyException = false;

      if (requireMention) {
        if (!botMentionPattern || !botMentionReplacePattern) {
          // app_mention events are inherently mentions (Slack guarantees this)
          // Allow them even without bot ID pattern
          if (eventType === 'app_mention') {
            // Mention is implied by event type - allow without pattern validation
            // We can't strip the mention without the pattern, but that's acceptable
            // (messageText stays as-is since we don't have botMentionReplacePattern)
            hasMention = true;
          } else {
            // SECURITY: Fail closed - if we can't verify mentions on message events, reject
            console.warn(
              '[slack] Cannot enforce mention requirement (bot user ID not available). Rejecting message event.'
            );
            return;
          }
        } else {
          // Bot ID available - perform normal mention validation
          hasMention = botMentionPattern.test(messageText);

          if (!hasMention) {
            // Check if this is a thread reply that's allowed without mention
            if (isThreadReply && allowThreadRepliesWithoutMention) {
              // Thread reply without mention - allow for conversation flow
              // SECURITY: Gateway service verifies a mapping exists before creating sessions.
              // Unmapped threads (where bot was never mentioned) will be rejected.
              // Set allow_thread_replies_without_mention: true only if you want to allow
              // continuing conversations in existing threads without requiring @mentions.
              allowedViaThreadReplyException = true;
            } else {
              // Reject: top-level message or thread reply not allowed without mention
              return;
            }
          }

          // Strip mention if present
          if (hasMention) {
            messageText = messageText.replace(botMentionReplacePattern, '').trim();
          }
        }
      }

      const threadId = event.thread_ts
        ? `${event.channel}-${event.thread_ts}`
        : `${event.channel}-${event.ts}`;

      console.log(
        `[slack] Inbound message: thread=${threadId} channel_type=${channelType} user=${event.user}`
      );

      callback({
        threadId,
        text: messageText,
        userId: event.user ?? 'unknown',
        timestamp: event.ts ?? new Date().toISOString(),
        metadata: {
          channel: event.channel,
          channel_type: event.channel_type,
          requires_mapping_verification: allowedViaThreadReplyException,
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
