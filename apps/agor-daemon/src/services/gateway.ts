/**
 * Gateway Service
 *
 * Core routing service that orchestrates message routing between
 * messaging platforms and Agor sessions. Custom service (not DrizzleService)
 * since it orchestrates across multiple repositories and services.
 */

import { type Database, GatewayChannelRepository, ThreadSessionMapRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { getConnector, hasConnector } from '@agor/core/gateway';
import type { AgenticToolName, ChannelType, Session, User } from '@agor/core/types';
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

  constructor(db: Database, app: Application) {
    this.channelRepo = new GatewayChannelRepository(db);
    this.threadMapRepo = new ThreadSessionMapRepository(db);
    this.app = app;
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
    } else {
      // New thread → create session via FeathersJS service
      const sessionsService = this.app.service('sessions') as {
        create: (data: Partial<Session>) => Promise<Session>;
      };

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
}

/**
 * Service factory function
 */
export function createGatewayService(db: Database, app: Application): GatewayService {
  return new GatewayService(db, app);
}
