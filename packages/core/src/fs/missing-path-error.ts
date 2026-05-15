/**
 * Structured error envelope for "DB row exists but filesystem path is gone"
 * (issue #1109).
 *
 * Thrown by the spawn-time pre-flight check before the daemon hands a missing
 * `cwd` to `child_process.spawn` — replaces the misleading
 * `spawn /usr/local/bin/node ENOENT` (which is reported against the executable,
 * not the cwd) and the equally-misleading `chdir(2) failed: No such file or
 * directory` with an actionable message + machine-readable code so the UI can
 * render a "Reclone / Delete record" card.
 *
 * The shape mirrors the `clone_error` / `repo:cloneError` precedent from PR
 * #1126: `code` + `message` for humans, plus IDs/path so the UI knows which
 * record to act on.
 */
import type { RepoID, WorktreeID } from '../types/id';

export type MissingPathSubject = 'worktree' | 'repo';

export type MissingPathAction = 'reclone_or_delete';

export interface MissingPathErrorPayload {
  /** Machine-readable code. */
  code: 'WORKTREE_PATH_MISSING' | 'REPO_PATH_MISSING';
  /** Subject ("worktree" or "repo"). Convenience for UI routing. */
  subject: MissingPathSubject;
  /** Human-readable message safe to surface in the UI. */
  message: string;
  /** Absolute path that was expected to exist but doesn't. */
  path: string;
  /** Suggested user action. Currently only one value, but kept open for future. */
  action: MissingPathAction;
  /** Worktree this references (always set for worktree-missing; set when the
   * miss was discovered while resolving a worktree-anchored operation). */
  worktree_id?: WorktreeID;
  /** Repo this references (always set for repo-missing; set when the miss
   * was discovered while resolving a worktree whose repo is also missing). */
  repo_id?: RepoID;
}

/**
 * Thrown when the daemon refuses to spawn (terminal / executor / git op)
 * because the resolved filesystem path is gone.
 *
 * Subclass of `Error` so it propagates through FeathersJS error handling
 * unchanged; the `data` property is serialised onto the wire response, which
 * is how the UI gets at the structured envelope.
 */
export class MissingPathError extends Error {
  readonly name = 'MissingPathError' as const;
  readonly data: MissingPathErrorPayload;
  /**
   * Feathers' error middleware copies `error.code` (numeric HTTP-ish status)
   * onto the response. We use 422 (Unprocessable Entity) because the request
   * itself is well-formed — the precondition just isn't satisfied. 404 would
   * imply "no such session/worktree", which is misleading; the row exists,
   * the on-disk artefact does not.
   */
  readonly code = 422;

  constructor(payload: MissingPathErrorPayload) {
    super(payload.message);
    this.data = payload;
  }
}

export function isMissingPathError(err: unknown): err is MissingPathError {
  return err instanceof MissingPathError;
}
