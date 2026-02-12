/**
 * Gateway Service
 *
 * Core routing service that orchestrates message routing between
 * messaging platforms and Agor sessions. Custom service (not DrizzleService)
 * since it orchestrates across multiple repositories and services.
 */

import {
  type Database,
  GatewayChannelRepository,
  ThreadSessionMapRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { GatewayConnector, InboundMessage } from '@agor/core/gateway';
import { getConnector, hasConnector } from '@agor/core/gateway';
import type {
  AgenticToolName,
  ChannelType,
  GatewayChannel,
  MessageSource,
  Session,
  User,
} from '@agor/core/types';
import { getDefaultPermissionMode, SessionStatus } from '@agor/core/types';

/**
 * Inbound message data (platform → session)
 */
interface PostMessageData {
  channel_key: string;
  thread_id: string;
  text: string;
  user_name?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Inbound message response
 */
interface PostMessageResult {
  success: boolean;
  sessionId: string;
  created: boolean;
}

/**
 * Outbound routing data (session → platform)
 */
interface RouteMessageData {
  session_id: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Outbound routing response
 */
interface RouteMessageResult {
  routed: boolean;
  channelType?: string;
}

/**
 * Gateway routing service
 */
export class GatewayService {
  private channelRepo: GatewayChannelRepository;
  private threadMapRepo: ThreadSessionMapRepository;
  private usersRepo: UsersRepository;
  private app: Application;

  /** Active Socket Mode listeners keyed by channel ID */
  private activeListeners = new Map<string, GatewayConnector>();

  /**
   * In-memory flag: true when at least one gateway channel exists.
   * Allows routeMessage() to skip the DB lookup entirely when the
   * gateway feature is not in use (the common case for most instances).
   * Updated on startup and whenever channels are created/deleted.
   */
  private hasActiveChannels = false;

  constructor(db: Database, app: Application) {
    this.channelRepo = new GatewayChannelRepository(db);
    this.threadMapRepo = new ThreadSessionMapRepository(db);
    this.usersRepo = new UsersRepository(db);
    this.app = app;
  }

  /**
   * Refresh the in-memory hasActiveChannels flag.
   * Called at startup and should be called when channels are created/deleted.
   */
  async refreshChannelState(): Promise<void> {
    const channels = await this.channelRepo.findAll();
    this.hasActiveChannels = channels.some((ch) => ch.enabled);
    console.log(
      `[gateway] refreshChannelState: found ${channels.length} channels, ${channels.filter((ch) => ch.enabled).length} enabled`
    );
  }

  /**
   * Send a debug/system message to the platform thread (fire-and-forget).
   * Useful for giving the user visibility into what's happening.
   */
  private sendDebugMessage(channel: GatewayChannel, threadId: string, text: string): void {
    if (!hasConnector(channel.channel_type as ChannelType)) return;
    try {
      const connector = getConnector(channel.channel_type as ChannelType, channel.config);
      connector
        .sendMessage({ threadId, text: `_[system] ${text}_` })
        .catch((err) => console.warn('[gateway] Debug message failed:', err));
    } catch {
      // Ignore — debug messages are best-effort
    }
  }

  /**
   * Inbound routing: platform → session
   *
   * Authenticates via channel_key, looks up or creates a session
   * for the given thread, and sends the prompt to the session.
   */
  async create(data: PostMessageData): Promise<PostMessageResult> {
    // 1. Authenticate via channel_key
    const channel = await this.channelRepo.findByKey(data.channel_key);
    if (!channel) {
      throw new Error('Invalid channel_key');
    }

    if (!channel.enabled) {
      throw new Error('Channel is disabled');
    }

    // 2. Look up existing thread mapping
    const existingMapping = await this.threadMapRepo.findByChannelAndThread(
      channel.id,
      data.thread_id
    );

    // 3. Cross-channel ownership check (MUST happen before any sendDebugMessage calls).
    // If this thread is owned by a DIFFERENT gateway channel on the same daemon,
    // silently drop the message — we must not interfere with another gateway's thread.
    // This covers all rejection paths: unmapped thread replies, user alignment failures, etc.
    if (!existingMapping) {
      const otherChannelMapping = await this.threadMapRepo.findByThread(data.thread_id);
      if (otherChannelMapping) {
        console.log(
          `[gateway] IGNORED: Thread ${data.thread_id} owned by channel ${otherChannelMapping.channel_id.substring(0, 8)}, not ours (${channel.id.substring(0, 8)}). Silently dropping.`
        );
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
    }

    // 4. Reject unmapped thread replies that came through without mention.
    // This prevents unauthorized session creation when users reply to random threads
    // without explicitly mentioning the bot. Only threads where the bot was mentioned
    // (creating a mapping) can continue conversations without mentions.
    // IMPORTANT: Silently drop — do NOT send a debug message. These are normal messages
    // in threads that have nothing to do with Agor. Sending a visible rejection would
    // cause the bot to spam every active thread in the channel.
    if (!existingMapping && data.metadata?.requires_mapping_verification) {
      // Use debug level — this fires for every non-Agor thread reply in monitored
      // channels and would create excessive log noise at info level.
      console.debug(
        `[gateway] IGNORED: Thread reply without mention in unmapped thread: channel=${channel.id.substring(0, 8)}, thread=${data.thread_id}`
      );
      return {
        success: false,
        sessionId: '',
        created: false,
      };
    }

    // 5. Fetch channel owner user (needed for auth context + agentic defaults)
    const usersService = this.app.service('users') as {
      get: (id: string) => Promise<User>;
    };
    const channelOwner = await usersService.get(channel.agor_user_id);

    // 6. Resolve effective user (Slack user alignment or channel owner fallback)
    let user = channelOwner;
    // Check both the channel config and the connector-reported metadata flag.
    // The metadata flag signals the connector actually attempted alignment for
    // this specific message (it has access to the runtime config at listen time).
    const alignSlackUsers =
      (channel.config as Record<string, unknown>).align_slack_users === true ||
      data.metadata?.align_slack_users === true;

    if (alignSlackUsers) {
      if (data.metadata?.slack_user_email && typeof data.metadata.slack_user_email === 'string') {
        const email = data.metadata.slack_user_email.toLowerCase().trim();
        const matchedUser = await this.usersRepo.findByEmail(email);

        if (matchedUser) {
          console.log(
            `[gateway] Slack user aligned: ${email} → Agor user ${matchedUser.user_id.substring(0, 8)} (${matchedUser.name || matchedUser.email})`
          );
          user = await usersService.get(matchedUser.user_id);
        } else {
          console.log(`[gateway] Slack user alignment failed: no Agor user with email ${email}`);
          this.sendDebugMessage(
            channel,
            data.thread_id,
            `User ${email} doesn't have an Agor account. Ask an admin to create an account with this email, or disable user alignment.`
          );
          return {
            success: false,
            sessionId: '',
            created: false,
          };
        }
      } else {
        // Alignment is enabled but email couldn't be resolved (missing
        // users:read.email scope, Slack API error, or no email on profile).
        // Reject instead of silently falling back to channel owner.
        console.log(
          `[gateway] Slack user alignment failed: could not resolve email for Slack user ${data.user_name ?? 'unknown'} (thread=${data.thread_id})`
        );
        this.sendDebugMessage(
          channel,
          data.thread_id,
          "Couldn't resolve your Slack identity. The bot may be missing the `users:read.email` scope, or your Slack profile has no email. Ask an admin to check the bot's scopes."
        );
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
    }

    let sessionId: string;
    let created = false;

    // Resolve agentic config: channel config > user defaults > system defaults
    const channelConfig = channel.agentic_config;
    const agenticTool: AgenticToolName = (channelConfig?.agent as AgenticToolName) ?? 'claude-code';
    const userDefaults = user.default_agentic_config?.[agenticTool];
    const permissionMode =
      channelConfig?.permissionMode ??
      userDefaults?.permissionMode ??
      getDefaultPermissionMode(agenticTool);
    const modelConfig = channelConfig?.modelConfig ?? userDefaults?.modelConfig;

    if (existingMapping) {
      // Existing thread → existing session
      sessionId = existingMapping.session_id;

      // Touch timestamps
      await this.threadMapRepo.updateLastMessage(existingMapping.id);

      this.sendDebugMessage(
        channel,
        data.thread_id,
        `Received follow-up, routing to session ${sessionId.substring(0, 8)}...`
      );
    } else {
      // New thread → create session via FeathersJS service
      const sessionsService = this.app.service('sessions') as {
        create: (data: Partial<Session>) => Promise<Session>;
      };

      this.sendDebugMessage(
        channel,
        data.thread_id,
        `Creating new ${agenticTool} session (${permissionMode} mode)...`
      );

      const session = await sessionsService.create({
        title: data.text.substring(0, 100),
        description: data.text,
        worktree_id: channel.target_worktree_id,
        created_by: user.user_id,
        // Stamp session with creator's unix_username for executor impersonation.
        // Normally set by the setSessionUnixUsername hook, but that hook skips
        // internal calls (no provider). Gateway sessions are internal, so we
        // must set it explicitly. When user alignment is active, this uses the
        // aligned user's unix_username; otherwise the channel owner's.
        unix_username: user.unix_username ?? null,
        status: SessionStatus.IDLE,
        agentic_tool: agenticTool,
        permission_config: { mode: permissionMode },
        model_config: modelConfig
          ? {
              mode: modelConfig.mode ?? 'alias',
              model: modelConfig.model ?? '',
              updated_at: new Date().toISOString(),
            }
          : undefined,
        tasks: [],
        message_count: 0,
        // Denormalized gateway metadata (immutable snapshot at creation time)
        // Avoids N+1 lookups when rendering board cards
        custom_context: {
          gateway_source: {
            channel_id: channel.id,
            channel_name: channel.name,
            channel_type: channel.channel_type,
            thread_id: data.thread_id,
          },
        },
      });

      sessionId = session.session_id;
      created = true;

      // Create thread → session mapping
      await this.threadMapRepo.create({
        channel_id: channel.id,
        thread_id: data.thread_id,
        session_id: session.session_id,
        worktree_id: channel.target_worktree_id,
        status: 'active',
        metadata: data.metadata ?? null,
      });

      // Get session URL from created session (URL is added by after hook)
      // Fetch the session to get the URL property
      let sessionUrl: string | null = null;
      try {
        const sessionsService = this.app.service('sessions') as {
          get: (id: string, params?: { user: User }) => Promise<Session & { url?: string | null }>;
        };
        const sessionWithUrl = await sessionsService.get(sessionId, { user });
        sessionUrl = sessionWithUrl.url || null;
      } catch (error) {
        console.warn('[gateway] Failed to fetch session URL:', error);
      }

      // Send debug message with session URL
      const sessionIdShort = sessionId.substring(0, 8);
      const message = sessionUrl
        ? `Session created: ${sessionUrl}`
        : `Session ${sessionIdShort} created, sending prompt to agent...`;

      this.sendDebugMessage(channel, data.thread_id, message);
    }

    // Touch channel last_message_at
    await this.channelRepo.updateLastMessage(channel.id);

    // 4. Check session status and route accordingly:
    //    - If session is IDLE → send prompt directly via /sessions/:id/prompt
    //    - If session is RUNNING/STOPPING → queue via /sessions/:id/messages/queue
    //    This matches the UI behavior and respects the one-task-at-a-time constraint
    try {
      // Re-fetch session to get current status
      const sessionsService = this.app.service('sessions') as {
        get: (id: string, params?: { user: User }) => Promise<Session>;
      };
      const currentSession = await sessionsService.get(sessionId, { user });

      const isRunning =
        currentSession.status === SessionStatus.RUNNING ||
        currentSession.status === SessionStatus.STOPPING;

      if (isRunning) {
        // Session is busy → queue the message
        const queueService = this.app.service(`/sessions/${sessionId}/messages/queue`) as {
          create: (
            data: { prompt: string },
            params: Record<string, unknown>
          ) => Promise<{ success: boolean; message: { queue_position: number } }>;
        };

        const response = await queueService.create({ prompt: data.text }, { user });

        console.log(
          `[gateway] Message queued for session ${sessionId.substring(0, 8)} at position ${response.message.queue_position}`
        );

        this.sendDebugMessage(
          channel,
          data.thread_id,
          `Session is busy, message queued at position ${response.message.queue_position}`
        );
      } else {
        // Session is idle → send prompt directly
        const promptService = this.app.service('/sessions/:id/prompt') as {
          create: (
            data: { prompt: string; permissionMode?: string; messageSource?: MessageSource },
            params: Record<string, unknown>
          ) => Promise<Record<string, unknown>>;
        };

        // Internal call: pass user, omit provider to bypass auth hooks
        // Mark message source as 'gateway' so it won't be echoed back to Slack
        await promptService.create(
          { prompt: data.text, permissionMode, messageSource: 'gateway' },
          { route: { id: sessionId }, user }
        );

        console.log(
          `[gateway] Prompt sent to session ${sessionId.substring(0, 8)} via /sessions/:id/prompt`
        );
      }
    } catch (error) {
      console.error('[gateway] Failed to send prompt to session:', error);
      this.sendDebugMessage(channel, data.thread_id, `Error sending prompt: ${error}`);
    }

    return {
      success: true,
      sessionId,
      created,
    };
  }

  /**
   * Outbound routing: session → platform
   *
   * Looks up session in thread_session_map. If no mapping exists,
   * returns a cheap no-op. Uses platform connectors to send messages.
   */
  async routeMessage(data: RouteMessageData): Promise<RouteMessageResult> {
    // Fast path: skip DB lookup entirely when no channels are configured
    if (!this.hasActiveChannels) {
      return { routed: false };
    }

    // Look up session in thread_session_map
    const mapping = await this.threadMapRepo.findBySession(data.session_id);

    if (!mapping) {
      // No mapping → cheap no-op (session is not gateway-connected)
      return { routed: false };
    }

    console.log(
      `[gateway] Found mapping: channel=${mapping.channel_id.substring(0, 8)}, thread=${mapping.thread_id}`
    );

    const channel = await this.channelRepo.findById(mapping.channel_id);

    if (!channel || !channel.enabled) {
      return { routed: false };
    }

    // Check if we have a connector for this channel type
    if (!hasConnector(channel.channel_type as ChannelType)) {
      console.warn(`[gateway] No connector for channel type: ${channel.channel_type}`);
      return { routed: false };
    }

    // Touch timestamps
    await this.threadMapRepo.updateLastMessage(mapping.id);
    await this.channelRepo.updateLastMessage(channel.id);

    // Send via platform connector
    try {
      const connector = getConnector(channel.channel_type as ChannelType, channel.config);

      const text = connector.formatMessage ? connector.formatMessage(data.message) : data.message;

      await connector.sendMessage({
        threadId: mapping.thread_id,
        text,
        metadata: data.metadata,
      });

      console.log(
        `[gateway] Routed message to ${channel.channel_type} thread ${mapping.thread_id}`
      );
    } catch (error) {
      console.error(`[gateway] Failed to route message to ${channel.channel_type}:`, error);
      return { routed: false, channelType: channel.channel_type };
    }

    return {
      routed: true,
      channelType: channel.channel_type,
    };
  }

  /**
   * Start Socket Mode listeners for all enabled channels that support it.
   * Called once at daemon startup. Inbound messages are routed through
   * the gateway's create() method (same path as webhook POST).
   */
  async startListeners(): Promise<void> {
    const channels = await this.channelRepo.findAll();
    const eligible = channels.filter(
      (ch) => ch.enabled && hasConnector(ch.channel_type as ChannelType) && ch.config.app_token
    );

    if (eligible.length === 0) {
      console.log('[gateway] No channels with Socket Mode configured');
      return;
    }

    for (const channel of eligible) {
      await this.startChannelListener(channel);
    }
  }

  /**
   * Start or stop a Socket Mode listener for a single channel based on its enabled state
   * (public wrapper for hook usage)
   */
  async startListenerForChannel(channelId: string): Promise<void> {
    const channel = await this.channelRepo.findById(channelId);
    if (!channel) {
      console.warn(`[gateway] Cannot manage listener: channel ${channelId} not found`);
      return;
    }

    // If channel is disabled, stop the listener
    if (!channel.enabled) {
      await this.stopChannelListener(channelId);
      console.log(`[gateway] Stopped listener for disabled channel ${channel.name}`);
      return;
    }

    // If no connector or no app_token, stop any existing listener
    if (!hasConnector(channel.channel_type as ChannelType)) {
      console.warn(`[gateway] No connector for channel type: ${channel.channel_type}`);
      await this.stopChannelListener(channelId);
      return;
    }
    if (!channel.config.app_token) {
      console.log(`[gateway] Skipping listener for channel ${channel.name} (no app_token)`);
      await this.stopChannelListener(channelId);
      return;
    }

    // Start or restart the listener
    await this.startChannelListener(channel);
  }

  /**
   * Stop a Socket Mode listener for a single channel
   */
  async stopChannelListener(channelId: string): Promise<void> {
    const connector = this.activeListeners.get(channelId);
    if (!connector) {
      return; // Not listening
    }

    try {
      if (connector.stopListening) {
        await connector.stopListening();
      }
      this.activeListeners.delete(channelId);
      console.log(`[gateway] Listener stopped for channel ${channelId.substring(0, 8)}`);
    } catch (error) {
      console.error(`[gateway] Error stopping listener for ${channelId}:`, error);
    }
  }

  /**
   * Start a Socket Mode listener for a single channel
   */
  private async startChannelListener(channel: GatewayChannel): Promise<void> {
    if (this.activeListeners.has(channel.id)) {
      return; // Already listening
    }

    try {
      const connector = getConnector(channel.channel_type as ChannelType, channel.config);

      if (!connector.startListening) {
        return; // Connector doesn't support listening
      }

      const callback = (msg: InboundMessage) => {
        this.create({
          channel_key: channel.channel_key,
          thread_id: msg.threadId,
          text: msg.text,
          user_name: msg.userId,
          metadata: msg.metadata,
        }).catch((error) => {
          console.error(
            `[gateway] Failed to process inbound message for channel ${channel.name}:`,
            error
          );
        });
      };

      await connector.startListening(callback);
      this.activeListeners.set(channel.id, connector);
      console.log(`[gateway] Socket Mode listener started for channel "${channel.name}"`);
    } catch (error) {
      console.error(`[gateway] Failed to start listener for channel "${channel.name}":`, error);
    }
  }

  /**
   * Stop all active listeners (called on shutdown)
   */
  async stopListeners(): Promise<void> {
    for (const [channelId, connector] of this.activeListeners) {
      try {
        if (connector.stopListening) {
          await connector.stopListening();
        }
        console.log(`[gateway] Listener stopped for channel ${channelId.substring(0, 8)}`);
      } catch (error) {
        console.error(`[gateway] Error stopping listener for ${channelId}:`, error);
      }
    }
    this.activeListeners.clear();
  }
}

/**
 * Service factory function
 */
export function createGatewayService(db: Database, app: Application): GatewayService {
  return new GatewayService(db, app);
}
