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
import type { ChannelType, Session } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';

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

    // 2. Look up existing thread mapping
    const existingMapping = await this.threadMapRepo.findByChannelAndThread(
      channel.id,
      data.thread_id
    );

    let sessionId: string;
    let created = false;

    if (existingMapping) {
      // Existing thread → existing session
      sessionId = existingMapping.session_id;

      // Touch timestamps
      await this.threadMapRepo.updateLastMessage(existingMapping.id);
    } else {
      // New thread → create session and mapping
      const sessionsService = this.app.service('sessions') as {
        create: (data: Partial<Session>) => Promise<Session>;
      };

      const session = await sessionsService.create({
        title: data.text.substring(0, 100),
        description: data.text,
        worktree_id: channel.target_worktree_id,
        created_by: channel.agor_user_id,
        status: SessionStatus.IDLE,
        agentic_tool: 'claude-code',
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

    // Create a task for the session (executor will pick it up)
    try {
      const tasksService = this.app.service('tasks') as {
        create: (data: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      await tasksService.create({
        session_id: sessionId,
        prompt: data.text,
        status: 'queued',
      });
    } catch (error) {
      console.warn('[gateway] Failed to create task for session:', error);
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
