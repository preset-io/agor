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
import { slackifyMarkdown } from 'slackify-markdown';

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

  // User alignment: resolve Slack user email → Agor user
  align_slack_users?: boolean;
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
 * Check if a bot mention pattern appears *outside* code blocks in Slack message text.
 *
 * Slack sends `<@U12345>` in `event.text` regardless of whether the mention is
 * inside a code block or not. However, `app_mention` events only fire for
 * "active" mentions (outside code blocks). This function strips code blocks
 * first, then tests for the mention pattern — so code-block mentions return false.
 *
 * Handles both triple-backtick blocks and inline backtick spans.
 */
function hasActiveMention(text: string, mentionPattern: RegExp): boolean {
  // Strip triple-backtick blocks first (```...```), then inline code (`...`)
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  // Reset lastIndex in case the pattern has global/sticky flags (defensive)
  mentionPattern.lastIndex = 0;
  return mentionPattern.test(stripped);
}

/**
 * Convert GitHub-flavored markdown to Slack mrkdwn format.
 *
 * Delegates to `slackify-markdown` which uses `unified`/`remark` with
 * custom Slack handlers. Handles bold, italic, strikethrough, links,
 * headings (→ bold), images (→ links), code blocks (strips lang),
 * lists, blockquotes, tables, and Slack character escaping.
 *
 * @see https://github.com/jsarafajr/slackify-markdown
 */
export function markdownToMrkdwn(markdown: string): string {
  return slackifyMarkdown(markdown).trim();
}

export class SlackConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'slack';

  private web: WebClient;
  private socketMode: SocketModeClient | null = null;
  private config: SlackConfig;
  private botUserId: string | null = null;

  /** Cache: Slack user ID → email (or null if unavailable). */
  private userEmailCache = new Map<string, { email: string | null; expiresAt: number }>();
  private static USER_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min for successful lookups
  private static USER_CACHE_ERROR_TTL_MS = 60 * 1000; // 1 min for errors (transient recovery)

  /**
   * Cache: Slack channel ID → channel type string (channel/group/mpim/im).
   *
   * Populated from:
   * 1. `message` events (which include reliable `channel_type`)
   * 2. `conversations.info` API calls (fallback for `app_mention` events)
   *
   * This avoids relying on the channel ID prefix (C/G/D) which is unreliable —
   * Slack private channels can have a `C` prefix.
   */
  private channelTypeCache = new Map<string, { type: string; expiresAt: number }>();
  private static CHANNEL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
  private static CHANNEL_CACHE_ERROR_TTL_MS = 60 * 1000; // 1 min for API errors

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
   * Look up a Slack user's email address by their user ID.
   *
   * Caches successful results for 15 minutes and errors for 1 minute
   * (so transient failures recover quickly). Evicts expired entries on
   * each call to prevent unbounded cache growth.
   *
   * Returns null if the email is unavailable (missing users:read.email scope,
   * bot user, restricted guest, or API error).
   */
  async lookupUserEmail(slackUserId: string): Promise<string | null> {
    const now = Date.now();

    // Evict expired entries to prevent unbounded growth
    for (const [key, entry] of this.userEmailCache) {
      if (entry.expiresAt <= now) this.userEmailCache.delete(key);
    }

    const cached = this.userEmailCache.get(slackUserId);
    if (cached && cached.expiresAt > now) {
      return cached.email;
    }

    try {
      const result = await this.web.users.info({ user: slackUserId });
      const email = result.user?.profile?.email ?? null;

      this.userEmailCache.set(slackUserId, {
        email,
        expiresAt: now + SlackConnector.USER_CACHE_TTL_MS,
      });

      if (email) {
        console.log(`[slack] Resolved user ${slackUserId} → ${email}`);
      } else {
        console.log(
          `[slack] User ${slackUserId} has no email (missing users:read.email scope or restricted account)`
        );
      }

      return email;
    } catch (error) {
      console.warn(`[slack] Failed to look up email for user ${slackUserId}:`, error);
      // Short TTL for errors so transient failures (rate limits, network) recover quickly
      this.userEmailCache.set(slackUserId, {
        email: null,
        expiresAt: now + SlackConnector.USER_CACHE_ERROR_TTL_MS,
      });
      return null;
    }
  }

  /**
   * Cache a known channel type from a trusted source (e.g. `message` event with explicit `channel_type`).
   */
  private cacheChannelType(channelId: string, type: string): void {
    this.channelTypeCache.set(channelId, {
      type,
      expiresAt: Date.now() + SlackConnector.CHANNEL_CACHE_TTL_MS,
    });
  }

  /**
   * Resolve the Slack channel type for a given channel ID.
   *
   * Resolution order:
   * 1. Explicit `channel_type` from the event (trusted, used by `message` events)
   * 2. In-memory cache (populated from prior `message` events or API calls)
   * 3. `conversations.info` API call (cached on success)
   * 4. Channel ID prefix inference (last resort, unreliable for private channels)
   */
  private async resolveChannelType(
    channelId: string,
    eventChannelType: string | undefined
  ): Promise<string | undefined> {
    // 1. Explicit channel_type from event — always trust it and cache for later
    if (eventChannelType) {
      this.cacheChannelType(channelId, eventChannelType);
      return eventChannelType;
    }

    // 2. Check cache (populated from message events or prior API calls)
    const now = Date.now();

    // Evict expired entries to prevent unbounded growth
    for (const [key, entry] of this.channelTypeCache) {
      if (entry.expiresAt <= now) this.channelTypeCache.delete(key);
    }

    const cached = this.channelTypeCache.get(channelId);
    if (cached) {
      return cached.type;
    }

    // 3. Call conversations.info API
    try {
      const result = await this.web.conversations.info({ channel: channelId });
      if (result.ok && result.channel) {
        const ch = result.channel as {
          is_channel?: boolean;
          is_group?: boolean;
          is_mpim?: boolean;
          is_im?: boolean;
          is_private?: boolean;
        };
        let resolvedType: string;
        if (ch.is_im) {
          resolvedType = 'im';
        } else if (ch.is_mpim) {
          resolvedType = 'mpim';
        } else if (ch.is_private || ch.is_group) {
          resolvedType = 'group';
        } else {
          resolvedType = 'channel';
        }
        console.log(`[slack] conversations.info resolved channel ${channelId} → ${resolvedType}`);
        this.cacheChannelType(channelId, resolvedType);
        return resolvedType;
      }
    } catch (error) {
      console.warn(`[slack] conversations.info failed for ${channelId}:`, error);
      // Cache the error briefly so we don't hammer the API
      // Fall through to prefix inference
    }

    // 4. Last resort: prefix inference for unambiguous prefixes only.
    // IMPORTANT: C-prefix is NOT used — private channels can have C-prefix,
    // and misclassifying them as public would recreate the original bug (#826).
    // G → group and D → DM are reliable inferences.
    const prefix = channelId.charAt(0);
    let inferredType: string | undefined;
    if (prefix === 'G') {
      inferredType = 'group';
    } else if (prefix === 'D') {
      inferredType = 'im';
    }
    if (inferredType) {
      console.warn(`[slack] Using prefix inference for channel ${channelId} → ${inferredType}`);
      // Short TTL for prefix-inferred types
      this.channelTypeCache.set(channelId, {
        type: inferredType,
        expiresAt: now + SlackConnector.CHANNEL_CACHE_ERROR_TTL_MS,
      });
    } else {
      console.warn(
        `[slack] Cannot determine channel type for ${channelId} (API failed, prefix ambiguous)`
      );
    }
    return inferredType;
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
      text: req.text,
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
    // Default to true: once a user @mentions the bot to start a thread,
    // they can continue the conversation without re-tagging. The gateway
    // service's mapping verification prevents abuse in unmapped threads.
    const allowThreadRepliesWithoutMention =
      this.config.allow_thread_replies_without_mention ?? true;

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

      // Resolve channel type early — needed for both dedup and filtering.
      // Uses cache (populated from prior message events) + conversations.info fallback.
      // This replaces the unreliable channel ID prefix inference that misclassified
      // private channels with C-prefix as public channels.
      const channelType = event.channel
        ? await this.resolveChannelType(event.channel, event.channel_type)
        : undefined;

      // IMPORTANT: Prevent duplicate processing
      // When a bot is mentioned, Slack sends BOTH 'app_mention' and 'message' events.
      // This happens for top-level messages AND thread replies.
      //
      // Strategy:
      // - Use 'app_mention' for active mentions outside code blocks
      // - Use 'message' for DMs, non-mention messages, and code-block-only mentions
      // - Skip 'message' events that have active mentions (to avoid duplicates)
      // - Skip 'app_mention' events where the mention is only inside code blocks
      //   (those are not "real" mentions and should be handled as plain messages)
      const isThreadReply = !!event.thread_ts;
      const isChannelMessage = channelType === 'channel' || channelType === 'group';

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

      if (isChannelMessage && botMentionPattern) {
        const mentionOutsideCodeBlock = hasActiveMention(event.text ?? '', botMentionPattern);

        if (eventType === 'message' && mentionOutsideCodeBlock) {
          // Active (non-code-block) mention detected in a message event.
          // Skip — the parallel app_mention event will handle it.
          return;
        }

        if (eventType === 'app_mention' && !mentionOutsideCodeBlock) {
          // app_mention fired but the mention is only inside a code block.
          // Skip — the parallel message event will handle it as a non-mention
          // (correctly rejected or routed via thread reply exception).
          return;
        }
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
          // Bot ID available - perform normal mention validation.
          // Only count mentions outside code blocks as active mentions.
          // Code-block mentions (e.g. `@bot`) are not "real" mentions and
          // should not trigger a response.
          hasMention = hasActiveMention(messageText, botMentionPattern);

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

      // Resolve Slack user email if align_slack_users is enabled
      let slackUserEmail: string | null = null;
      if (this.config.align_slack_users && event.user) {
        slackUserEmail = await this.lookupUserEmail(event.user);
      }

      callback({
        threadId,
        text: messageText,
        userId: event.user ?? 'unknown',
        timestamp: event.ts ?? new Date().toISOString(),
        metadata: {
          channel: event.channel,
          channel_type: channelType,
          requires_mapping_verification: allowedViaThreadReplyException,
          ...(slackUserEmail ? { slack_user_email: slackUserEmail } : {}),
          // Signal that user alignment was attempted so the gateway can
          // reject (instead of silently falling back to channel owner)
          // when the email couldn't be resolved.
          ...(this.config.align_slack_users ? { align_slack_users: true } : {}),
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
