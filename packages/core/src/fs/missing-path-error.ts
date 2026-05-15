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
 * Extends Feathers' `Unprocessable` (HTTP 422) so it propagates through the
 * standard error middleware unchanged: the `data` payload is serialised onto
 * the wire response — which is how the UI gets the structured envelope —
 * and `name` / `code` / `className` follow Feathers conventions for free.
 * 422 (Unprocessable Entity) is the right status: the request itself is
 * well-formed, the precondition just isn't satisfied. 404 would imply "no
 * such session/worktree", which is misleading — the row exists, the on-disk
 * artefact does not.
 */
import { Unprocessable } from '../feathers';
import type { RepoID, WorktreeID } from '../types/id';

export type MissingPathSubject = 'worktree' | 'repo';

export type MissingPathAction = 'reclone_or_delete';

export interface MissingPathErrorPayload {
  /** Machine-readable code. */
  code: 'WORKTREE_PATH_MISSING' | 'REPO_PATH_MISSING';
  /** Subject ("worktree" or "repo"). Convenience for UI routing. */
  subject: MissingPathSubject;
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
 * because the resolved filesystem path is gone. See module docstring for
 * rationale.
 */
export class MissingPathError extends Unprocessable {
  // Sentinel for `isMissingPathError` — Feathers' error middleware
  // serializes own-properties onto the wire response, so callers that only
  // see the serialized envelope can still discriminate.
  readonly _missingPath = true as const;

  constructor(message: string, data: MissingPathErrorPayload) {
    super(message, data);
    // Override Feathers' default name so error.name reflects the structured
    // semantics instead of the generic 'Unprocessable'.
    this.name = 'MissingPathError';
  }

  get payload(): MissingPathErrorPayload {
    return this.data as MissingPathErrorPayload;
  }
}

export function isMissingPathError(err: unknown): err is MissingPathError {
  return (
    err instanceof MissingPathError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { _missingPath?: unknown })._missingPath === true)
  );
}
