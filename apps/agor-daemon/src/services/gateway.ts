/**
 * Gateway Service
 *
 * Core routing service that orchestrates message routing between
 * messaging platforms and Agor sessions. Custom service (not DrizzleService)
 * since it orchestrates across multiple repositories and services.
 */

import { type Database, GatewayChannelRepository, ThreadSessionMapRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { GatewayConnector, InboundMessage } from '@agor/core/gateway';
import { getConnector, hasConnector } from '@agor/core/gateway';
import type { AgenticToolName, ChannelType, GatewayChannel, Session, User } from '@agor/core/types';
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
    this.app = app;
  }

  /**
   * Refresh the in-memory hasActiveChannels flag.
   * Called at startup and should be called when channels are created/deleted.
   */
  async refreshChannelState(): Promise<void> {
    const channels = await this.channelRepo.findAll();
    this.hasActiveChannels = channels.some((ch) => ch.enabled);
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

    // 2. Fetch channel owner user (needed for auth context + agentic defaults)
    const usersService = this.app.service('users') as {
      get: (id: string) => Promise<User>;
    };
    const user = await usersService.get(channel.agor_user_id);

    // 3. Look up existing thread mapping
    const existingMapping = await this.threadMapRepo.findByChannelAndThread(
      channel.id,
      data.thread_id
    );

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
        created_by: channel.agor_user_id,
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

      this.sendDebugMessage(
        channel,
        data.thread_id,
        `Session ${sessionId.substring(0, 8)} created, sending prompt to agent...`
      );
    }

    // Touch channel last_message_at
    await this.channelRepo.updateLastMessage(channel.id);

    // 4. Send prompt via /sessions/:id/prompt — triggers full flow:
    //    task creation, user message, git state, executor spawn
    try {
      const promptService = this.app.service('/sessions/:id/prompt') as {
        create: (
          data: { prompt: string; permissionMode?: string },
          params: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      };

      // Internal call: pass user, omit provider to bypass auth hooks
      await promptService.create(
        { prompt: data.text, permissionMode },
        { route: { id: sessionId }, user }
      );

      console.log(
        `[gateway] Prompt sent to session ${sessionId.substring(0, 8)} via /sessions/:id/prompt`
      );
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
