/**
 * Realign a repo's on-disk `remote.origin.url` to match the canonical value
 * stored in the database.
 *
 * This is the daemon-side wrapper around `ensureGitRemoteUrl` from
 * `@agor/core/git`. The core helper is pure (no DB knowledge); this wrapper
 * looks up the Repo row, derives the path + expected URL, and calls the
 * primitive.
 *
 * Why: worktrees share `.git/config` with their base repo, so any agent or
 * external tool that overwrites `remote.origin.url` with a credential-bearing
 * variant taints every sibling worktree until detected. The hot path is
 * read-only (one `git getRemotes`, ~10–20ms) and a no-op when already aligned,
 * so calling this from task-completion and repo-patch hooks keeps the
 * canonical URL canonical without measurable cost.
 *
 * Pairs with `security.git_config_parameters` (transfer hardening): even when
 * drift slips past this realignment, the tainted URL is unusable for fetch /
 * push under git 2.41+. This helper handles the *cleanup* side; the env-var
 * hardening handles the *exploitation* side.
 *
 * See `docs/internal/credential-leak-defenses-2026-05-11.md`.
 */

import type { Application } from '@agor/core/feathers';
import { ensureGitRemoteUrl } from '@agor/core/git';
import type { Repo, RepoID } from '@agor/core/types';

/**
 * Look up a repo, then realign its `remote.origin.url` to the DB's canonical
 * value if it has drifted. Fire-and-forget by design — callers should
 * `.catch(...)` and continue on failure (transient git locks, corrupt repo
 * state, etc.).
 *
 * Skips non-remote repos and repos missing a `remote_url` (local-only repos
 * have no canonical URL to align to).
 *
 * On drift, emits a `[SECURITY]` log line. The *previous* (tainted) URL is
 * deliberately NOT logged: if the drift came from a token-in-URL leak, the
 * previous value carries the secret. The slug + new (canonical) URL are
 * sufficient for an operator to correlate with timing and recent agent
 * activity.
 */
export async function ensureRepoOriginAligned(app: Application, repoId: RepoID): Promise<void> {
  let repo: Repo;
  try {
    repo = (await app.service('repos').get(repoId)) as Repo;
  } catch {
    // Repo missing or service unavailable — fire-and-forget caller doesn't
    // need to know. Realignment is best-effort.
    return;
  }

  if (repo.repo_type !== 'remote') return;
  if (!repo.remote_url) return;
  if (!repo.local_path) return;

  const result = await ensureGitRemoteUrl(repo.local_path, 'origin', repo.remote_url);
  if (result.changed) {
    console.warn(
      `[SECURITY] Realigned remote.origin.url for repo ${repoId} ` +
        `(slug=${repo.slug}); previous URL omitted from log to avoid leaking ` +
        `any embedded credential. Canonical URL now: ${repo.remote_url}`
    );
  }
}
