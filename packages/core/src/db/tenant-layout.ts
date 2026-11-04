/**
 * `--target-layout clone`: rewrite moved branch and repository rows for a
 * destination that re-clones from remotes instead of receiving checkouts.
 * Every branch becomes clone storage at the destination's managed path; its
 * checkout is re-provisioned by "Retry provisioning". Local-home teammates
 * (no remote) keep `ready` because their trees travel in the archive's files.
 * Repository rows point at the destination's managed path and are marked for
 * re-clone.
 */

export interface CloneLayoutPaths {
  /** Destination branch path for `<repo slug>/<branch name>`. */
  branchPath(repoSlug: string, branchName: string): string;
  /** Destination managed repository path for a slug. */
  repoPath(repoSlug: string): string;
}

export const MOVED_BRANCH_MESSAGE =
  'Moved to this workspace without its checkout. Retry provisioning to clone it from the repository.';
export const MOVED_REPO_MESSAGE =
  'Moved to this workspace without a local copy. Clone it again to restore it.';

type Row = Record<string, unknown> & { data?: Record<string, unknown> };

type RawJson = { rawJSON(text: string): unknown };

/**
 * Parse an archive line without losing number precision: any number whose
 * source text does not survive a JS `Number` round trip (big integers, `1.10`)
 * is kept as raw JSON so `JSON.stringify` re-emits the original digits.
 */
function parseLossless(line: string): Row {
  return JSON.parse(line, (_key, value, context?: { source?: string }) =>
    typeof value === 'number' && context?.source !== undefined && String(value) !== context.source
      ? (JSON as unknown as RawJson).rawJSON(context.source)
      : value
  ) as Row;
}

/** Rewrite archived JSONL lines of `repos`/`branches`; other tables pass through. */
export function createCloneLayoutTransform(
  paths: CloneLayoutPaths,
  readTable: (name: string) => string[]
): (tableName: string, lines: string[]) => string[] {
  const slugByRepoId = new Map<string, string>();
  for (const line of readTable('repos')) {
    const row = parseLossless(line);
    if (typeof row.repo_id === 'string' && typeof row.slug === 'string') {
      slugByRepoId.set(row.repo_id, row.slug);
    }
  }
  return (tableName, lines) => {
    if (tableName === 'repos') {
      return lines.map((line) => {
        const row = parseLossless(line);
        const slug = String(row.slug);
        let local: string;
        try {
          local = paths.repoPath(slug);
        } catch {
          return line;
        }
        row.data = {
          ...(row.data ?? {}),
          local_path: local,
          clone_status: 'failed',
          clone_error: { exit_code: 1, category: 'unknown', message: MOVED_REPO_MESSAGE },
        };
        return JSON.stringify(row);
      });
    }
    if (tableName === 'branches') {
      return lines.map((line) => {
        const row = parseLossless(line);
        const slug = slugByRepoId.get(String(row.repo_id));
        if (!slug || typeof row.name !== 'string') return line;
        let path: string;
        try {
          path = paths.branchPath(slug, row.name);
        } catch {
          return line;
        }
        const teammate = (
          row.data?.custom_context as { teammate?: { localHome?: boolean } } | undefined
        )?.teammate;
        const localHome = teammate?.localHome === true;
        row.storage_mode = 'clone';
        row.data = { ...(row.data ?? {}), path };
        if (!localHome && row.filesystem_status !== 'preserved') {
          row.filesystem_status = 'failed';
          row.data.error_message = MOVED_BRANCH_MESSAGE;
        }
        return JSON.stringify(row);
      });
    }
    return lines;
  };
}
