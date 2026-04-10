/**
 * Short ID Resolution Utilities for MCP Tools
 *
 * Resolves short ID prefixes (e.g. "5bb05f13") to full UUIDs by looking up
 * the entity via the service layer. Each resolver calls service.get() which
 * triggers the repository's resolveId() — handling exact match, prefix match,
 * ambiguity errors, and not-found errors consistently.
 *
 * Usage: call at the top of MCP tool handlers before using IDs in service
 * calls, route params, or FK values.
 *
 * All functions accept IdInput (short prefix or full UUID) and return the
 * canonical full UUID.
 */

import type {
  ArtifactID,
  BoardID,
  IdInput,
  RepoID,
  SessionID,
  TaskID,
  UserID,
  WorktreeID,
} from '@agor/core/types';
import type { McpContext } from './server.js';

export async function resolveSessionId(ctx: McpContext, id: IdInput): Promise<SessionID> {
  const entity = await ctx.app.service('sessions').get(id, ctx.baseServiceParams);
  return entity.session_id;
}

export async function resolveWorktreeId(ctx: McpContext, id: IdInput): Promise<WorktreeID> {
  const entity = await ctx.app.service('worktrees').get(id, ctx.baseServiceParams);
  return entity.worktree_id;
}

export async function resolveBoardId(ctx: McpContext, id: IdInput): Promise<BoardID> {
  const entity = await ctx.app.service('boards').get(id, ctx.baseServiceParams);
  return entity.board_id;
}

export async function resolveRepoId(ctx: McpContext, id: IdInput): Promise<RepoID> {
  const entity = await ctx.app.service('repos').get(id, ctx.baseServiceParams);
  return entity.repo_id;
}

export async function resolveCardId(ctx: McpContext, id: IdInput): Promise<string> {
  const entity = await ctx.app.service('cards').get(id, ctx.baseServiceParams);
  return entity.card_id;
}

export async function resolveTaskId(ctx: McpContext, id: IdInput): Promise<TaskID> {
  const entity = await ctx.app.service('tasks').get(id, ctx.baseServiceParams);
  return entity.task_id;
}

export async function resolveUserId(ctx: McpContext, id: IdInput): Promise<UserID> {
  const entity = await ctx.app.service('users').get(id, ctx.baseServiceParams);
  return entity.user_id;
}

export async function resolveMcpServerId(ctx: McpContext, id: IdInput): Promise<string> {
  const entity = await ctx.app.service('mcp-servers').get(id, ctx.baseServiceParams);
  return entity.mcp_server_id;
}

export async function resolveArtifactId(ctx: McpContext, id: IdInput): Promise<ArtifactID> {
  const entity = await ctx.app.service('artifacts').get(id, ctx.baseServiceParams);
  return entity.artifact_id;
}
