/**
 * DaemonClient - Abstraction for executor to request operations from daemon
 *
 * This client sends IPC commands to the daemon for operations that require
 * database access, Feathers services, or other daemon-only functionality.
 *
 * Replaces direct access to:
 * - MessagesService / MessagesRepository
 * - SessionsRepository
 * - TasksService
 * - PermissionService
 * - Other database/service operations
 */

import type { Message, MessageID, SessionID, TaskID } from '@agor/core/types';
import type { ExecutorIPCServer } from '../ipc-server.js';

export interface StreamChunkParams {
  message_id: MessageID;
  text: string;
}

export interface StreamStartParams {
  message_id: MessageID;
  session_id: SessionID;
  task_id?: TaskID;
  role: string;
  timestamp: string;
}

export class DaemonClient {
  constructor(
    private ipcServer: ExecutorIPCServer,
    private sessionToken: string
  ) {}

  /**
   * Create a message in the database
   */
  async createMessage(message: Message): Promise<void> {
    await this.ipcServer.request('daemon_command', {
      command: 'create_message',
      session_token: this.sessionToken,
      data: message,
    });
  }

  /**
   * Update session properties
   */
  async updateSession(sessionId: SessionID, data: Record<string, unknown>): Promise<void> {
    await this.ipcServer.request('daemon_command', {
      command: 'update_session',
      session_token: this.sessionToken,
      data: { session_id: sessionId, ...data },
    });
  }

  /**
   * Update task properties
   */
  async updateTask(taskId: TaskID, data: Record<string, unknown>): Promise<void> {
    await this.ipcServer.request('daemon_command', {
      command: 'update_task',
      session_token: this.sessionToken,
      data: { task_id: taskId, ...data },
    });
  }

  /**
   * Stream a text chunk to the UI (WebSocket only, not persisted)
   */
  async streamChunk(params: StreamChunkParams): Promise<void> {
    await this.ipcServer.notify('daemon_command', {
      command: 'stream_chunk',
      session_token: this.sessionToken,
      data: params,
    });
  }

  /**
   * Notify that streaming has started (WebSocket only)
   */
  async streamStart(params: StreamStartParams): Promise<void> {
    await this.ipcServer.notify('daemon_command', {
      command: 'stream_start',
      session_token: this.sessionToken,
      data: params,
    });
  }

  /**
   * Request permission for a tool use
   * Returns whether the permission was granted
   */
  async requestPermission(params: {
    task_id: TaskID;
    tool_name: string;
    tool_params: unknown;
  }): Promise<{ approved: boolean; reason?: string }> {
    const result = await this.ipcServer.request('request_permission', {
      session_token: this.sessionToken,
      ...params,
    });

    return result as { approved: boolean; reason?: string };
  }

  /**
   * Get messages for a session (for counting, indexing, etc.)
   */
  async getMessages(sessionId: SessionID): Promise<Message[]> {
    const result = await this.ipcServer.request('daemon_command', {
      command: 'get_messages',
      session_token: this.sessionToken,
      data: { session_id: sessionId },
    });

    return result as Message[];
  }

  /**
   * Get session data
   */
  async getSession(sessionId: SessionID): Promise<unknown> {
    const result = await this.ipcServer.request('daemon_command', {
      command: 'get_session',
      session_token: this.sessionToken,
      data: { session_id: sessionId },
    });

    return result;
  }

  /**
   * Emit permission event to daemon for WebSocket broadcasting
   * The daemon will broadcast the event to all connected UI clients
   */
  async emitPermissionEvent(params: { event: string; data: unknown }): Promise<void> {
    await this.ipcServer.notify('daemon_command', {
      command: 'emit_permission_event',
      session_token: this.sessionToken,
      data: params,
    });
  }

  /**
   * Notify daemon about thinking stream start
   */
  async thinkingStart(params: { message_id: MessageID; metadata: unknown }): Promise<void> {
    await this.ipcServer.notify('daemon_command', {
      command: 'thinking_start',
      session_token: this.sessionToken,
      data: params,
    });
  }

  /**
   * Stream a thinking chunk to the UI
   */
  async thinkingChunk(params: { message_id: MessageID; chunk: string }): Promise<void> {
    await this.ipcServer.notify('daemon_command', {
      command: 'thinking_chunk',
      session_token: this.sessionToken,
      data: params,
    });
  }

  /**
   * Notify daemon about thinking stream end
   */
  async thinkingEnd(params: { message_id: MessageID }): Promise<void> {
    await this.ipcServer.notify('daemon_command', {
      command: 'thinking_end',
      session_token: this.sessionToken,
      data: params,
    });
  }
}
