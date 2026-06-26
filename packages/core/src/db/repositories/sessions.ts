/**
 * Session Repository
 *
 * Type-safe CRUD operations for sessions with short ID support.
 */

import type { BranchID, Session, SessionID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { getBaseUrl } from '../../config/config-manager';
import { generateId, shortId } from '../../lib/ids';
import { getSessionUrl } from '../../utils/url';
import type { Database } from '../client';
import { deleteFrom, insert, lockRowForUpdate, select, txAsDb, update } from '../database-wrapper';
import {
  branches,
  branchOwners,
  messages,
  type SessionInsert,
  type SessionRow,
  sessions,
} from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import { visibleBranchAccessCondition } from './branch-access';
import { deepMerge } from './merge-utils';

/**
 * Session with enriched last message
 */
export interface SessionWithLastMessage extends Session {
  last_message?: string;
}

/**
 * Patches that only acknowledge UI attention state should not make a session
 * look recently active. Keep this intentionally value-aware: setting
 * ready_for_prompt=true is emitted by task/stop/executor completion paths and
 * is activity; clearing it is the session-open/highlight acknowledgement path.
 *
 * Do not add title/description/model/permission fields here — those are
 * user-visible session metadata changes and should continue to affect recency.
 */
function isSessionTimestampNeutralPatch(updates: Partial<Session>): boolean {
  const keys = Object.keys(updates);
  return keys.length === 1 && keys[0] === 'ready_for_prompt' && updates.ready_for_prompt === false;
}

/**
 * Session repository implementation
 */
export class SessionRepository implements BaseRepository<Session, Partial<Session>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Session type.
   *
   * `branchBoardId` is still threaded through because we expose it
   * as `Session.branch_board_id` for clients that want to know
   * without a follow-up branch fetch. URLs are flat (`/s/<short>/`)
   * and resolve to the session's branch's board at click time, so no
   * slug join is needed.
   */
  private rowToSession(row: SessionRow, branchBoardId?: UUID | null, baseUrl?: string): Session {
    const genealogyData = row.data.genealogy || { children: [] };
    const sessionId = row.session_id as SessionID;
    const boardId = branchBoardId ?? null;

    // Compute URL only when baseUrl is available AND the session's
    // branch is on a board — without a board the deep link would
    // resolve the session but have nowhere to switch the canvas to.
    const url = baseUrl && boardId ? getSessionUrl(sessionId, baseUrl) : null;

    return {
      session_id: sessionId,
      status: row.status,
      agentic_tool: row.agentic_tool,
      created_at: new Date(row.created_at).toISOString(),
      last_updated: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
      created_by: row.created_by,
      unix_username: row.unix_username || null,
      branch_id: row.branch_id as UUID,
      branch_board_id: boardId,
      url,
      ...row.data,
      tasks: row.data.tasks.map((id) => id as UUID),
      genealogy: {
        parent_session_id: row.parent_session_id as UUID | undefined,
        forked_from_session_id: row.forked_from_session_id as UUID | undefined,
        fork_point_task_id: genealogyData.fork_point_task_id as UUID | undefined,
        fork_point_message_index: genealogyData.fork_point_message_index,
        spawn_point_task_id: genealogyData.spawn_point_task_id as UUID | undefined,
        spawn_point_message_index: genealogyData.spawn_point_message_index,
        children: genealogyData.children.map((id) => id as UUID),
      },
      permission_config: row.data.permission_config,
      scheduled_run_at: row.scheduled_run_at ?? undefined,
      scheduled_from_branch: row.scheduled_from_branch ?? false,
      schedule_id: (row.schedule_id as UUID | null) ?? undefined,
      ready_for_prompt: row.ready_for_prompt ?? false,
      archived: Boolean(row.archived), // Convert SQLite integer (0/1) to boolean
      archived_reason: row.archived_reason ?? undefined,
      current_context_usage: row.data.current_context_usage,
      context_window_limit: row.data.context_window_limit,
      last_context_update_at: row.data.last_context_update_at,
    };
  }

  /**
   * Convert Session to database insert format
   */
  private sessionToInsert(session: Partial<Session>): SessionInsert {
    const now = Date.now();
    const sessionId = session.session_id ?? generateId();

    if (!session.branch_id) {
      throw new RepositoryError('Session must have a branch_id');
    }
    if (!session.created_by) {
      throw new RepositoryError('Session must have a created_by');
    }

    return {
      session_id: sessionId,
      created_at: new Date(session.created_at ? session.created_at : now),
      updated_at: session.last_updated ? new Date(session.last_updated) : new Date(now),
      status: session.status ?? SessionStatus.IDLE,
      agentic_tool: session.agentic_tool ?? 'claude-code',
      created_by: session.created_by,
      unix_username: session.unix_username ?? null, // Stamped at creation time by setSessionUnixUsername hook
      board_id: null, // Board ID tracked separately in boards.sessions array
      parent_session_id: session.genealogy?.parent_session_id ?? null,
      forked_from_session_id: session.genealogy?.forked_from_session_id ?? null,
      branch_id: session.branch_id,
      scheduled_run_at: session.scheduled_run_at ?? null,
      scheduled_from_branch: session.scheduled_from_branch ?? false,
      schedule_id: session.schedule_id ?? null,
      ready_for_prompt: session.ready_for_prompt ?? false,
      archived: session.archived ?? false, // Default false for new sessions
      archived_reason: session.archived_reason ?? null,
      data: {
        agentic_tool_version: session.agentic_tool_version,
        sdk_session_id: session.sdk_session_id, // Preserve SDK session ID for conversation continuity
        mcp_token: session.mcp_token, // MCP authentication token for Agor self-access
        title: session.title,
        description: session.description,
        git_state: session.git_state ?? {
          ref: 'main',
          base_sha: '',
          current_sha: '',
        },
        genealogy: session.genealogy ?? {
          children: [],
        },
        contextFiles: session.contextFiles ?? [],
        tasks: session.tasks ?? [],
        permission_config: session.permission_config,
        model_config: session.model_config ?? undefined,
        callback_config: session.callback_config,
        fork_origin: session.fork_origin,
        custom_context: session.custom_context,
        current_context_usage: session.current_context_usage,
        context_window_limit: session.context_window_limit,
        last_context_update_at: session.last_context_update_at,
        // Claude Code CLI adapter state. Hard-coded in this insert
        // builder so updates to `cli_state` actually persist — without
        // this entry deepMerge in update() would put the field on the
        // in-memory object but sessionToInsert would drop it on save.
        cli_state: session.cli_state,
        // Billing model snapshot (subscription / api-key / unknown).
        billing_mode: session.billing_mode,
      },
    };
  }

  /**
   * Resolve short ID to full ID via the centralized helper.
   */
  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'Session', async (pattern) => {
      const rows = await select(this.db)
        .from(sessions)
        .where(like(sessions.session_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { session_id: string }) => r.session_id);
    });
  }

  /**
   * Create a new session
   */
  async create(data: Partial<Session>): Promise<Session> {
    try {
      const insertData = this.sessionToInsert(data);
      await insert(this.db, sessions).values(insertData).run();

      const baseUrl = await getBaseUrl();

      // LEFT JOIN with branches and boards to get board_id and slug
      const result = await select(this.db)
        .from(sessions)
        .leftJoin(branches, eq(sessions.branch_id, branches.branch_id))
        .where(eq(sessions.session_id, insertData.session_id))
        .one();

      if (!result) {
        throw new RepositoryError('Failed to retrieve created session');
      }

      const sessionRow = result.sessions;
      const boardId = (result.branches?.board_id ?? null) as UUID | null;

      return this.rowToSession(sessionRow, boardId, baseUrl);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find session by ID (supports short ID)
   *
   * Automatically LEFT JOINs with branches table to populate branch_board_id and url.
   * This avoids N+1 queries when URL generation is needed.
   */
  async findById(id: string): Promise<Session | null> {
    try {
      const fullId = await this.resolveId(id);
      const baseUrl = await getBaseUrl();

      // LEFT JOIN with branches and boards to get board_id and slug in a single query
      const result = await select(this.db)
        .from(sessions)
        .leftJoin(branches, eq(sessions.branch_id, branches.branch_id))
        .where(eq(sessions.session_id, fullId))
        .one();

      if (!result) {
        return null;
      }

      // Extract session row, board_id, and slug from JOIN result
      const sessionRow = result.sessions;
      const boardId = (result.branches?.board_id ?? null) as UUID | null;

      return this.rowToSession(sessionRow, boardId, baseUrl);
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find only the branch ID for a session. Used by realtime routing hot paths
   * to avoid loading/enriching the full session row.
   */
  async findBranchIdBySessionId(id: string): Promise<BranchID | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db, { branch_id: sessions.branch_id })
        .from(sessions)
        .where(eq(sessions.session_id, fullId))
        .one();
      return (row?.branch_id as BranchID | undefined) ?? null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find session branch: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all sessions
   *
   * LEFT JOINs with branches to populate board_id and url in a single query.
   */
  async findAll(filter?: { visibleToUserId?: UUID }): Promise<Session[]> {
    try {
      const baseUrl = await getBaseUrl();

      const conditions = [];
      if (filter?.visibleToUserId) {
        conditions.push(visibleBranchAccessCondition(this.db, filter.visibleToUserId));
      }

      // biome-ignore lint/suspicious/noExplicitAny: Conditional query builder shape differs with the RBAC join
      const query: any = filter?.visibleToUserId
        ? select(this.db)
            .from(sessions)
            .leftJoin(branches, eq(sessions.branch_id, branches.branch_id))
            .leftJoin(
              branchOwners,
              and(
                eq(branchOwners.branch_id, branches.branch_id),
                eq(branchOwners.user_id, filter.visibleToUserId)
              )
            )
        : select(this.db)
            .from(sessions)
            .leftJoin(branches, eq(sessions.branch_id, branches.branch_id));

      const results =
        conditions.length > 0 ? await query.where(and(...conditions)).all() : await query.all();

      return results.map(
        (result: {
          sessions: SessionRow;
          branches?: { board_id?: string } | null;
          boards?: { slug?: string | null } | null;
        }) => {
          const sessionRow = result.sessions;
          const boardId = (result.branches?.board_id ?? null) as UUID | null;
          return this.rowToSession(sessionRow, boardId, baseUrl);
        }
      );
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find sessions by status
   *
   * LEFT JOINs with branches to populate board_id and url.
   */
  async findByStatus(status: Session['status']): Promise<Session[]> {
    try {
      const baseUrl = await getBaseUrl();

      const results = await select(this.db)
        .from(sessions)
        .leftJoin(branches, eq(sessions.branch_id, branches.branch_id))
        .where(eq(sessions.status, status))
        .all();

      return results.map(
        (result: {
          sessions: SessionRow;
          branches?: { board_id?: string } | null;
          boards?: { slug?: string | null } | null;
        }) => {
          const sessionRow = result.sessions;
          const boardId = (result.branches?.board_id ?? null) as UUID | null;
          return this.rowToSession(sessionRow, boardId, baseUrl);
        }
      );
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions by status: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find sessions by board ID
   *
   * A session relates to a board through its branch (session.branch_id →
   * branch.board_id), so we filter on the JOINed `branches.board_id`. The
   * `sessions.board_id` column is intentionally never populated (see
   * `sessionToInsert`), so filtering on it would always return zero rows —
   * the branch join is the authoritative source. This still pushes the
   * filter down to SQL (one indexed JOIN), not an in-memory scan.
   */
  async findByBoard(boardId: string, filter?: { visibleToUserId?: UUID }): Promise<Session[]> {
    try {
      const baseUrl = await getBaseUrl();

      const conditions = [eq(branches.board_id, boardId)];
      if (filter?.visibleToUserId) {
        conditions.push(visibleBranchAccessCondition(this.db, filter.visibleToUserId));
      }

      // Filter on the branch's board_id via the JOIN (sessions.board_id is dead).
      // biome-ignore lint/suspicious/noExplicitAny: Conditional query builder shape differs with the RBAC join
      const query: any = filter?.visibleToUserId
        ? select(this.db)
            .from(sessions)
            .innerJoin(branches, eq(sessions.branch_id, branches.branch_id))
            .leftJoin(
              branchOwners,
              and(
                eq(branchOwners.branch_id, branches.branch_id),
                eq(branchOwners.user_id, filter.visibleToUserId)
              )
            )
        : select(this.db)
            .from(sessions)
            .innerJoin(branches, eq(sessions.branch_id, branches.branch_id));
      const results = await query.where(and(...conditions)).all();

      return results.map(
        (result: {
          sessions: SessionRow;
          branches?: { board_id?: string } | null;
          boards?: { slug?: string | null } | null;
        }) => {
          const sessionRow = result.sessions;
          // We know board_id from the filter, but still get it from JOIN for consistency
          const board_id = (result.branches?.board_id ?? null) as UUID | null;
          return this.rowToSession(sessionRow, board_id, baseUrl);
        }
      );
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions by board: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Paginated session listing with SQL-side filtering, recency sort, and
   * limit/offset. Powers the bounded first-paint slices (recent-N and the
   * board-scoped set) so the cap, the recency ordering, and the board filter all
   * run in SQL.
   *
   * Why SQL and not the generic in-memory path: the Session object exposes its
   * last-updated time as `last_updated`, but callers sort by the DB column name
   * `updated_at`. `DrizzleService.sortData` / `paginateClientSide` would look up
   * `item.updated_at` (undefined) and no-op the sort, then slice an arbitrary
   * page. Ordering here on the real `sessions.updated_at` column makes the
   * recent-N slice actually recent. board_id is matched via the branches JOIN
   * (`sessions.board_id` is never populated — see `sessionToInsert`).
   *
   * @returns `{ data, total }` where `total` is the full match count (so Feathers
   *          pagination and the client `findAll` loop behave correctly).
   */
  async findPage(opts: {
    boardId?: string;
    archived?: boolean;
    sortUpdatedAt?: 1 | -1;
    limit?: number;
    skip?: number;
    visibleToUserId?: UUID;
  }): Promise<{ data: Session[]; total: number }> {
    try {
      const baseUrl = await getBaseUrl();

      const conditions = [];
      if (opts.boardId !== undefined) conditions.push(eq(branches.board_id, opts.boardId));
      if (opts.archived !== undefined) conditions.push(eq(sessions.archived, opts.archived));
      if (opts.visibleToUserId) {
        conditions.push(visibleBranchAccessCondition(this.db, opts.visibleToUserId));
      }
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Total matching rows — drives Feathers pagination + the findAll loop.
      // biome-ignore lint/suspicious/noExplicitAny: Conditional query builder shape differs with the RBAC join
      let countQuery: any = select(this.db, { count: sql<number>`count(*)` })
        .from(sessions)
        .leftJoin(branches, eq(sessions.branch_id, branches.branch_id));
      if (opts.visibleToUserId) {
        countQuery = countQuery.leftJoin(
          branchOwners,
          and(
            eq(branchOwners.branch_id, branches.branch_id),
            eq(branchOwners.user_id, opts.visibleToUserId)
          )
        );
      }
      const countRow = await (whereClause ? countQuery.where(whereClause) : countQuery).one();
      const total = Number(countRow?.count ?? 0);

      // Page of rows, recency-sorted in SQL on the real `updated_at` column.
      // biome-ignore lint/suspicious/noExplicitAny: Conditional query builder shape differs with the RBAC join
      let dataQuery: any = select(this.db)
        .from(sessions)
        .leftJoin(branches, eq(sessions.branch_id, branches.branch_id));
      if (opts.visibleToUserId) {
        dataQuery = dataQuery.leftJoin(
          branchOwners,
          and(
            eq(branchOwners.branch_id, branches.branch_id),
            eq(branchOwners.user_id, opts.visibleToUserId)
          )
        );
      }
      if (whereClause) dataQuery = dataQuery.where(whereClause);
      if (opts.sortUpdatedAt !== undefined) {
        dataQuery = dataQuery.orderBy(
          opts.sortUpdatedAt === -1 ? desc(sessions.updated_at) : sessions.updated_at
        );
      }
      if (opts.limit !== undefined) dataQuery = dataQuery.limit(opts.limit);
      if (opts.skip) dataQuery = dataQuery.offset(opts.skip);

      const results = await dataQuery.all();
      const data = results.map(
        (result: { sessions: SessionRow; branches?: { board_id?: string } | null }) => {
          const boardId = (result.branches?.board_id ?? null) as UUID | null;
          return this.rowToSession(result.sessions, boardId, baseUrl);
        }
      );

      return { data, total };
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions page: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find child sessions (forked or spawned from this session)
   *
   * LEFT JOINs with branches to populate board_id and url.
   */
  async findChildren(sessionId: string): Promise<Session[]> {
    try {
      const fullId = await this.resolveId(sessionId);
      const baseUrl = await getBaseUrl();

      // Query sessions where parent_session_id or forked_from_session_id matches
      // Use database-agnostic JSON extraction helper
      const { jsonExtract } = await import('../database-wrapper');

      const results = await select(this.db)
        .from(sessions)
        .leftJoin(branches, eq(sessions.branch_id, branches.branch_id))
        .where(
          or(
            sql`${jsonExtract(this.db, sessions.data, 'genealogy.parent_session_id')} = ${fullId}`,
            sql`${jsonExtract(this.db, sessions.data, 'genealogy.forked_from_session_id')} = ${fullId}`
          )
        )
        .all();

      return results.map(
        (result: {
          sessions: SessionRow;
          branches?: { board_id?: string } | null;
          boards?: { slug?: string | null } | null;
        }) => {
          const sessionRow = result.sessions;
          const boardId = (result.branches?.board_id ?? null) as UUID | null;
          return this.rowToSession(sessionRow, boardId, baseUrl);
        }
      );
    } catch (error) {
      throw new RepositoryError(
        `Failed to find child sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find ancestor sessions (parent chain)
   *
   * OPTIMIZED: Uses indexed parent_session_id lookups instead of iterating with findById.
   * Each parent lookup is O(log n) on indexed column instead of potentially O(1) hash on ID.
   * Total still O(n) but with dramatically lower constant factor due to schema optimization.
   */
  async findAncestors(sessionId: string): Promise<Session[]> {
    try {
      const fullId = await this.resolveId(sessionId);
      const ancestors: Session[] = [];
      const visited = new Set<string>();

      let currentSessionId: string | undefined = fullId;
      let depth = 0;
      const MAX_DEPTH = 100; // Prevent infinite loops

      while (currentSessionId && depth < MAX_DEPTH) {
        // Get current session to find parent
        const current = await this.findById(currentSessionId);
        if (!current) break;

        const parentId =
          current.genealogy?.parent_session_id || current.genealogy?.forked_from_session_id;

        if (!parentId || visited.has(parentId)) break;

        // Use indexed parent lookup (faster than looping through all sessions)
        const parent = await this.findById(parentId);
        if (!parent) break;

        ancestors.push(parent);
        visited.add(parentId);
        currentSessionId = parentId;
        depth++;
      }

      return ancestors;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find ancestor sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update session by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., user changes settings while permission
   * hook is saving allowedTools).
   */
  async update(id: string, updates: Partial<Session>): Promise<Session> {
    try {
      const fullId = await this.resolveId(id);
      const baseUrl = await getBaseUrl();

      const statusInfo = updates.status
        ? ` (status: ${updates.status}, ready_for_prompt: ${updates.ready_for_prompt})`
        : '';
      console.debug(`🔄 [SessionRepo] Updating session ${shortId(fullId)}${statusInfo}`);

      // Use transaction to make read-merge-write atomic
      // This prevents race conditions where another update happens between read and write
      const result = await this.db.transaction(async (tx) => {
        // STEP 0: Acquire row-level lock on PostgreSQL to prevent lost updates.
        // Without FOR UPDATE, two concurrent patches can both read the same state,
        // then the last writer silently overwrites the first writer's changes.

        await lockRowForUpdate(txAsDb(tx), this.db, sessions, eq(sessions.session_id, fullId));

        // STEP 1: Read current session with branch and board JOINs (within transaction)
        const currentResult = await select(txAsDb(tx))
          .from(sessions)
          .leftJoin(branches, eq(sessions.branch_id, branches.branch_id))
          .where(eq(sessions.session_id, fullId))
          .one();

        if (!currentResult) {
          throw new EntityNotFoundError('Session', id);
        }

        const currentRow = currentResult.sessions;
        const boardId = (currentResult.branches?.board_id ?? null) as UUID | null;
        const current = this.rowToSession(currentRow, boardId, baseUrl);

        // STEP 2: Deep merge updates into current session (in memory)
        // IMPORTANT: Receiver-side merge for nested objects (permission_config, model_config, etc.)
        // This prevents partial updates from losing existing nested fields.
        // Strategy: Objects = deep merge, Arrays = replace, Primitives = replace
        const merged = deepMerge(current, updates);

        const insertData = this.sessionToInsert(merged);

        // STEP 3: Write merged session (within same transaction)
        // Pass all columns via insertData (matches branch repo pattern).
        // Previously used an explicit column allowlist that silently dropped
        // columns like archived/archived_reason, causing data to revert on reload.
        // Refresh updated_at for meaningful updates. sessionToInsert() preserves
        // the old timestamp from the merged session, so timestamp-neutral UI
        // acknowledgements (currently only ready_for_prompt:false) can keep
        // recency ordering stable. Meaningful activity/settings/status patches
        // still advance it; without that, the staleness check in query-builder.ts
        // (hoursSinceUpdate > 24) would erroneously clear sdk_session_id and
        // disconnect agents from their history.
        const shouldRefreshLastUpdated = !isSessionTimestampNeutralPatch(updates);
        if (shouldRefreshLastUpdated) {
          insertData.updated_at = new Date();
        }

        await update(txAsDb(tx), sessions)
          .set(insertData)
          .where(eq(sessions.session_id, fullId))
          .run();

        if (!insertData.updated_at) {
          throw new RepositoryError('Session update did not produce an updated_at timestamp');
        }

        // Return merged session with the persisted timestamp.
        merged.last_updated = insertData.updated_at.toISOString();
        return merged;
      });

      return result;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Count messages for a session (live query, no caching)
   */
  async countMessages(sessionId: string): Promise<number> {
    const fullId = await this.resolveId(sessionId);
    const result = await select(this.db, {
      count: sql<number>`count(*)`,
    })
      .from(messages)
      .where(eq(messages.session_id, fullId))
      .one();
    return Number(result?.count ?? 0);
  }

  /**
   * Delete session by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, sessions)
        .where(eq(sessions.session_id, fullId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('Session', id);
      }
    } catch (error) {
      console.error(`❌ [SessionRepo] Failed to delete session ${id}:`, error);
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find sessions with running tasks
   */
  async findRunning(): Promise<Session[]> {
    return this.findByStatus(SessionStatus.RUNNING);
  }

  /**
   * Count total sessions
   */
  async count(): Promise<number> {
    try {
      const result = await select(this.db, { count: sql<number>`count(*)` }).from(sessions).one();

      return result?.count ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find the session that corresponds to one specific scheduled run.
   *
   * Used by the scheduler to dedup: "is there already a session for
   * (schedule_id, scheduled_run_at)?". Uses the covering index
   * `sessions_schedule_run_unique (schedule_id, scheduled_run_at)` so the
   * lookup is O(log n), not an O(n) full table scan.
   *
   * Returns the matching session (with branch_board_id + url populated
   * like the other readers in this repo) or null if no match.
   */
  async findScheduleRun(
    scheduleId: import('@agor/core/types').ScheduleID,
    scheduledRunAt: number
  ): Promise<Session | null> {
    try {
      const baseUrl = await getBaseUrl();
      const result = await select(this.db)
        .from(sessions)
        .leftJoin(branches, eq(sessions.branch_id, branches.branch_id))
        .where(
          and(eq(sessions.schedule_id, scheduleId), eq(sessions.scheduled_run_at, scheduledRunAt))
        )
        .one();
      if (!result) return null;
      const r = result as {
        sessions: SessionRow;
        branches?: { board_id?: string } | null;
      };
      const boardId = (r.branches?.board_id ?? null) as UUID | null;
      return this.rowToSession(r.sessions, boardId, baseUrl);
    } catch (error) {
      throw new RepositoryError(
        `Failed to find scheduled run: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all sessions for a schedule, optionally ordered by scheduled_run_at.
   *
   * Used by the scheduler for retention enforcement (`desc` to keep the
   * newest N) and the run-index count. Uses the same
   * `sessions_schedule_run_unique` as `findScheduleRun`.
   */
  async findByScheduleId(
    scheduleId: import('@agor/core/types').ScheduleID,
    opts: { orderByScheduledRunAt?: 'asc' | 'desc' } = {}
  ): Promise<Session[]> {
    try {
      const baseUrl = await getBaseUrl();
      let query = select(this.db)
        .from(sessions)
        .leftJoin(branches, eq(sessions.branch_id, branches.branch_id))
        .where(eq(sessions.schedule_id, scheduleId));
      if (opts.orderByScheduledRunAt === 'desc') {
        query = query.orderBy(desc(sessions.scheduled_run_at));
      } else if (opts.orderByScheduledRunAt === 'asc') {
        query = query.orderBy(sessions.scheduled_run_at);
      }
      const results = await query.all();
      return results.map(
        (result: { sessions: SessionRow; branches?: { board_id?: string } | null }) => {
          const boardId = (result.branches?.board_id ?? null) as UUID | null;
          return this.rowToSession(result.sessions, boardId, baseUrl);
        }
      );
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions by schedule: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Count sessions linked to a schedule. Used by the scheduler to
   * compute the `run_index` ('this is the Nth run of schedule X') for
   * the spawned session's `custom_context.scheduled_run`.
   */
  async countByScheduleId(scheduleId: import('@agor/core/types').ScheduleID): Promise<number> {
    try {
      const result = await select(this.db, { count: sql<number>`count(*)` })
        .from(sessions)
        .where(eq(sessions.schedule_id, scheduleId))
        .one();
      return Number(result?.count ?? 0);
    } catch (error) {
      throw new RepositoryError(
        `Failed to count sessions by schedule: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * True iff at least one session in this branch has a status in the
   * given set. Generic primitive — the caller owns the policy
   * (e.g. the scheduler's "active statuses" list lives in `scheduler.ts`
   * next to the concurrency-guard call site, not here).
   *
   * Implemented as an existence probe (`SELECT 1 ... LIMIT 1`) rather
   * than a COUNT so busy branches don't pay the cost of counting every
   * matching row.
   */
  async existsInBranchWithStatuses(
    branchId: import('@agor/core/types').BranchID,
    statuses: ReadonlyArray<Session['status']>
  ): Promise<boolean> {
    if (statuses.length === 0) return false;
    try {
      const row = await select(this.db, { one: sql<number>`1` })
        .from(sessions)
        .where(and(eq(sessions.branch_id, branchId), inArray(sessions.status, [...statuses])))
        .limit(1)
        .one();
      return row != null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to probe sessions in branch: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all sessions in branches accessible to a user (optimized RBAC query)
   *
   * Uses INNER JOIN + LEFT JOIN to filter sessions by branch access in one query
   * instead of N+1. Returns sessions where user is a branch owner OR branch.others_can
   * allows at least 'view' access.
   *
   * Also populates board_id and url via the branches JOIN.
   *
   * NOTE: This method should only be called when RBAC is enabled. When RBAC is disabled,
   * the scopeSessionQuery hook is not registered, so default Feathers query is used
   * (which returns all sessions without filtering).
   *
   * @param userId - User ID to check access for
   * @param boardId - Optional board filter, pushed down to SQL via the branch
   *                  join (session → branch → board). Lets callers scope to a
   *                  single board without an in-memory pass.
   * @returns Array of accessible sessions with urls populated
   */
  async findAccessibleSessions(userId: UUID, boardId?: UUID): Promise<Session[]> {
    const baseUrl = await getBaseUrl();

    // Join branches for board_id (exposed as Session.branch_board_id).
    // No boards join needed — flat `/s/<short>/` URLs don't carry a slug.
    const accessCondition = visibleBranchAccessCondition(this.db, userId);
    const whereCondition = boardId
      ? and(accessCondition, eq(branches.board_id, boardId))
      : accessCondition;
    const results = await select(this.db)
      .from(sessions)
      .innerJoin(branches, eq(sessions.branch_id, branches.branch_id))
      .leftJoin(
        branchOwners,
        and(eq(branchOwners.branch_id, branches.branch_id), eq(branchOwners.user_id, userId))
      )
      .where(whereCondition)
      .all();

    const seen = new Set<string>();
    const sessionsOut: Session[] = [];
    for (const result of results as Array<{
      sessions: SessionRow;
      branches?: { board_id?: string } | null;
      boards?: { slug?: string | null } | null;
    }>) {
      if (seen.has(result.sessions.session_id)) continue;
      seen.add(result.sessions.session_id);
      const boardId = (result.branches?.board_id ?? null) as UUID | null;
      sessionsOut.push(this.rowToSession(result.sessions, boardId, baseUrl));
    }
    return sessionsOut;
  }

  /**
   * Enrich a single session with last assistant message
   *
   * @param session - Session to enrich
   * @param truncationLength - Maximum length for last_message (default: 500)
   * @returns Session with last_message added
   */
  async enrichWithLastMessage(
    session: Session,
    truncationLength = 500
  ): Promise<SessionWithLastMessage> {
    const enriched = await this.enrichManyWithLastMessage([session], truncationLength);
    return enriched[0] || session;
  }

  /**
   * Enrich multiple sessions with last assistant message (batch operation)
   *
   * Fetches the most recent assistant message for each session.
   *
   * @param sessions - Array of sessions to enrich
   * @param truncationLength - Maximum length for last_message (default: 500)
   * @returns Array of sessions with last_message added
   */
  async enrichManyWithLastMessage(
    sessions: Session[],
    truncationLength = 500
  ): Promise<SessionWithLastMessage[]> {
    // Quick path: if no sessions, return empty array
    if (sessions.length === 0) {
      return [];
    }

    try {
      const sessionIds = sessions.map((s) => s.session_id);

      // Import messages table dynamically
      const { messages: messagesTable } = await import('../schema');

      // Get last assistant message for each session using N+1 queries
      // This is acceptable since we're enriching a small number of sessions at a time
      // Much better than fetching all messages which could be huge for long-running sessions
      const lastMessageBySession = new Map<string, string>();

      for (const sessionId of sessionIds) {
        const query = select(this.db, {
          data: messagesTable.data,
        })
          .from(messagesTable)
          .where(and(eq(messagesTable.session_id, sessionId), eq(messagesTable.role, 'assistant')));

        // Chain orderBy and limit, then execute with one()
        // The spread operator in the wrapper passes through these methods
        const lastMessage = await query.orderBy(desc(messagesTable.index)).limit(1).one();

        if (lastMessage) {
          // Extract text content from message data and truncate to requested length
          const messageData = lastMessage.data as {
            content?: Array<{ type: string; text?: string }>;
          };
          let fullText = '';

          // Extract text from content blocks (messages can have multiple content blocks)
          if (messageData?.content && Array.isArray(messageData.content)) {
            fullText = messageData.content
              .filter((block) => block.type === 'text' && block.text)
              .map((block) => block.text)
              .join('\n');
          }

          // Truncate to requested length
          if (fullText.length > truncationLength) {
            fullText = `${fullText.substring(0, truncationLength)}...`;
          }

          lastMessageBySession.set(sessionId, fullText);
        }
      }

      // Enrich sessions with last message
      return sessions.map((session) => {
        const lastMessage = lastMessageBySession.get(session.session_id) || '';
        return {
          ...session,
          last_message: lastMessage,
        };
      });
    } catch (error) {
      console.warn(
        'Failed to enrich sessions with last message:',
        error instanceof Error ? error.message : String(error)
      );
      // Return sessions without last message on error
      return sessions.map((session) => ({ ...session, last_message: '' }));
    }
  }

  /**
   * Check whether a session with the given id exists. Used by the MCP-token
   * validation path to reject tokens whose session has been deleted.
   */
  async exists(sessionId: string): Promise<boolean> {
    try {
      const row = (await select(this.db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one()) as { session_id?: string } | null | undefined;
      return row != null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to check session existence: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
