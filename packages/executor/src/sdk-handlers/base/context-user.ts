/**
 * Context User Resolution
 *
 * Shared logic for deciding which user a prompt executes "as" — used for
 * per-user OAuth token injection, API keys, and environment variables.
 *
 * A session can be prompted by multiple users over its lifetime: each Task is
 * a distinct prompt that may come from a different user. Credentials must
 * attribute to the user who issued the CURRENT prompt (the task creator), not
 * the session owner. We fall back to the session owner when the task lookup is
 * unavailable (no task id, no tasks service, or a failed fetch).
 *
 * All SDK handlers (Claude, Codex, Gemini) resolve context this way so the
 * behavior cannot drift between agents.
 */

import type { TaskID, UserID } from '../../types.js';
import type { TasksService } from './service-clients.js';

export interface ResolveContextUserParams {
  /** The session being prompted (only `created_by` is read). */
  session: { created_by?: string | null };
  /** The task representing the current prompt, if known. */
  taskId?: TaskID;
  /** Service used to look up the task's creator. */
  tasksService?: TasksService;
}

/**
 * Resolve the user whose credentials/context a prompt should run under.
 *
 * Priority: task creator (the prompter) > session owner (fallback).
 */
export async function resolveContextUserId(
  params: ResolveContextUserParams
): Promise<UserID | undefined> {
  const { session, taskId, tasksService } = params;

  let contextUserId = (session.created_by ?? undefined) as UserID | undefined;

  if (taskId && tasksService) {
    try {
      const task = await tasksService.get(taskId);
      if (task?.created_by) {
        contextUserId = task.created_by as UserID;
      }
    } catch {
      // Fall back to the session owner if the task lookup fails.
    }
  }

  return contextUserId;
}
