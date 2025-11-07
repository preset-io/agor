/**
 * Sessions Service
 *
 * Provides REST + WebSocket API for session management.
 * Uses DrizzleService adapter with SessionRepository.
 */

import { type Database, SessionRepository } from '@agor/core/db';
import type { Paginated, QueryParams, Session, TaskID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Session service params
 */
export type SessionParams = QueryParams<{
  status?: Session['status'];
  agentic_tool?: Session['agentic_tool'];
  board_id?: string;
}>;

/**
 * Extended sessions service with custom methods
 */
export class SessionsService extends DrizzleService<Session, Partial<Session>, SessionParams> {
  private sessionRepo: SessionRepository;

  constructor(db: Database) {
    const sessionRepo = new SessionRepository(db);
    super(sessionRepo, {
      id: 'session_id',
      resourceType: 'Session',
      paginate: {
        default: 50,
        max: 1000, // Increased from 100 to allow fetching more sessions
      },
      multi: ['patch', 'remove'], // Allow multi-patch and multi-remove
    });

    this.sessionRepo = sessionRepo;
  }

  /**
   * Custom method: Fork a session
   *
   * Creates a new session branching from the current session at a decision point.
   */
  async fork(
    id: string,
    data: { prompt: string; task_id?: string },
    params?: SessionParams
  ): Promise<Session> {
    const parent = await this.get(id, params);

    const forkedSession = await this.create(
      {
        agentic_tool: parent.agentic_tool,
        status: SessionStatus.IDLE,
        title: data.prompt.substring(0, 100), // First 100 chars as title
        description: data.prompt,
        worktree_id: parent.worktree_id,
        git_state: { ...parent.git_state },
        genealogy: {
          forked_from_session_id: parent.session_id,
          fork_point_task_id: data.task_id as TaskID,
          fork_point_message_index: parent.message_count, // Capture parent's message count at fork time
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        tasks: [],
        message_count: 0,
        // Don't copy sdk_session_id - fork will get its own via forkSession:true
      },
      params
    );

    // Update parent's children list
    const parentChildren = parent.genealogy?.children || [];
    // Cast forkedSession to Session to handle return type
    const session = forkedSession as Session;
    await this.patch(
      id,
      {
        genealogy: {
          ...parent.genealogy,
          children: [...parentChildren, session.session_id],
        },
      },
      params
    );

    return session;
  }

  /**
   * Custom method: Spawn a child session
   *
   * Creates a new session for delegating a subsession to another agent.
   */
  async spawn(
    id: string,
    data: {
      prompt: string;
      title?: string;
      agentic_tool?: Session['agentic_tool'];
      task_id?: string;
    },
    params?: SessionParams
  ): Promise<Session> {
    const parent = await this.get(id, params);

    const spawnedSession = await this.create(
      {
        agentic_tool: data.agentic_tool || parent.agentic_tool,
        status: SessionStatus.IDLE,
        title: data.title || data.prompt.substring(0, 100), // Use provided title or first 100 chars
        description: data.prompt,
        worktree_id: parent.worktree_id,
        git_state: { ...parent.git_state },
        genealogy: {
          parent_session_id: parent.session_id,
          spawn_point_task_id: data.task_id as TaskID,
          spawn_point_message_index: parent.message_count, // Capture parent's message count at spawn time
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        tasks: [],
        message_count: 0,
        // Don't copy sdk_session_id - spawn will get its own via forkSession:true
      },
      params
    );

    // Update parent's children list
    const parentChildren = parent.genealogy?.children || [];
    // Cast spawnedSession to Session to handle return type
    const session = spawnedSession as Session;
    await this.patch(
      id,
      {
        genealogy: {
          ...parent.genealogy,
          children: [...parentChildren, session.session_id],
        },
      },
      params
    );

    return session;
  }

  /**
   * Custom method: Get session genealogy tree
   *
   * Returns ancestors and descendants for visualization.
   */
  async getGenealogy(
    id: string,
    params?: SessionParams
  ): Promise<{
    session: Session;
    ancestors: Session[];
    children: Session[];
  }> {
    const session = await this.get(id, params);

    // Get ancestors
    const ancestors = await this.sessionRepo.findAncestors(id);

    // Get children
    const children = await this.sessionRepo.findChildren(id);

    return {
      session,
      ancestors,
      children,
    };
  }

  /**
   * Override remove to cascade delete children (forks and subsessions)
   */
  async remove(
    id: import('@agor/core/types').NullableId,
    params?: SessionParams
  ): Promise<Session | Session[]> {
    // Handle batch delete
    if (id === null) {
      // For multi-delete, get all matching sessions and delete each one
      const sessions = (await super.find(params)) as Session[];
      const results: Session[] = [];

      for (const session of sessions) {
        const deleted = (await this.remove(session.session_id, params)) as Session;
        results.push(deleted);
      }

      return results;
    }

    // Single delete with cascade
    // Get the session before deleting
    const session = await this.get(id, params);

    // Find all children (forks and subsessions)
    const children = await this.sessionRepo.findChildren(id as string);

    // Recursively delete all children first
    if (children.length > 0) {
      console.log(
        `🗑️  Cascading delete: session ${String(id).substring(0, 8)} has ${children.length} children`
      );

      for (const child of children) {
        await this.remove(child.session_id, params);
      }
    }

    // Now delete the current session (messages and tasks are cascade-deleted by DB)
    await this.sessionRepo.delete(id as string);

    console.log(`✅ Deleted session ${String(id).substring(0, 8)} and all descendants`);

    // Emit removed event for WebSocket broadcasting
    this.emit?.('removed', session, params);

    return session;
  }

  /**
   * Override find to support custom filtering
   */
  async find(params?: SessionParams): Promise<Paginated<Session> | Session[]> {
    // If filtering by status, use repository method (more efficient)
    if (params?.query?.status) {
      const sessions = await this.sessionRepo.findByStatus(params.query.status);

      // Apply pagination if enabled
      if (this.paginate) {
        const limit = params.query.$limit ?? this.paginate.default ?? 50;
        const skip = params.query.$skip ?? 0;

        return {
          total: sessions.length,
          limit,
          skip,
          data: sessions.slice(skip, skip + limit),
        };
      }

      return sessions;
    }

    // Otherwise use default find
    return super.find(params);
  }
}

/**
 * Service factory function
 */
export function createSessionsService(db: Database): SessionsService {
  return new SessionsService(db);
}
