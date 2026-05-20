/**
 * Parse the `<sha>-dirty` format produced by `getGitState` in
 * `packages/core/src/git/index.ts`. The daemon appends a literal `-dirty`
 * suffix when the working tree has uncommitted changes; UI code needs to
 * split that back out for display.
 *
 * Returns `{ cleanSha: '', isDirty: false }` for empty / `'unknown'` input
 * so callers can pass `session.git_state.current_sha` directly without
 * pre-filtering.
 */
const DIRTY_SUFFIX = '-dirty';

export interface ParsedGitStateSha {
  /** The raw commit SHA with the `-dirty` suffix removed (if present). */
  cleanSha: string;
  /** True when the working tree had uncommitted changes when the SHA was captured. */
  isDirty: boolean;
}

export function parseGitStateSha(sha: string | null | undefined): ParsedGitStateSha {
  if (!sha) return { cleanSha: '', isDirty: false };
  if (sha.endsWith(DIRTY_SUFFIX)) {
    return { cleanSha: sha.slice(0, -DIRTY_SUFFIX.length), isDirty: true };
  }
  return { cleanSha: sha, isDirty: false };
}
