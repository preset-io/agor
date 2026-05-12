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
import type { HookContext, Repo, RepoID } from '@agor/core/types';

/**
 * Two entry points are exported here:
 *
 *   - {@link ensureRepoOriginAlignedById} — when the caller has a `repoId`
 *     and needs the helper to fetch the row. Used from places where the row
 *     isn't already in scope (e.g. task-completion in tasks.ts).
 *   - {@link ensureRepoOriginAlignedForRepo} — when the caller already has
 *     the patched Repo row in hand (e.g. a Feathers after-hook receives
 *     `context.result`). Skips the redundant fetch.
 *
 * Both share the same core: if the repo is remote-with-URL, compare the DB
 * canonical URL to the on-disk `remote.origin.url` and `--replace-all` if
 * they've drifted.
 *
 * Fire-and-forget by design — callers should `.catch(...)` and continue on
 * failure (transient git locks, corrupt repo state, etc.). Realignment is
 * best-effort cleanup, not load-bearing for the calling op.
 *
 * On drift, emits a `[SECURITY]` log line. The *previous* (tainted) URL is
 * deliberately NOT logged: if the drift came from a token-in-URL leak, the
 * previous value carries the secret. The slug + new (canonical) URL are
 * sufficient for an operator to correlate with timing and recent agent
 * activity.
 */

/**
 * Realign `remote.origin.url` for a repo identified by ID.
 *
 * Fetches the row via Feathers, then delegates to {@link ensureRepoOriginAlignedForRepo}.
 * Errors fetching the row are swallowed (best-effort contract).
 */
export async function ensureRepoOriginAlignedById(app: Application, repoId: RepoID): Promise<void> {
  let repo: Repo;
  try {
    repo = (await app.service('repos').get(repoId)) as Repo;
  } catch {
    // Repo missing or service unavailable — fire-and-forget caller doesn't
    // need to know. Realignment is best-effort.
    return;
  }
  return ensureRepoOriginAlignedForRepo(repo);
}

/**
 * Realign `remote.origin.url` for a Repo row the caller already has.
 *
 * Use from Feathers after-hooks (`context.result` already IS the patched
 * Repo) to avoid a redundant `service('repos').get()` round-trip.
 *
 * No-op when:
 *   - `repo_type` is `'local'` (no canonical URL to align to)
 *   - `remote_url` is unset (defensive — shouldn't happen for healthy
 *     remote rows but the type marks it optional)
 *   - `local_path` is unset (same reasoning)
 */
export async function ensureRepoOriginAlignedForRepo(repo: Repo): Promise<void> {
  if (repo.repo_type !== 'remote') return;
  if (!repo.remote_url) return;
  if (!repo.local_path) return;

  const result = await ensureGitRemoteUrl(repo.local_path, 'origin', repo.remote_url);
  if (result.changed) {
    console.warn(
      `[SECURITY] Realigned remote.origin.url for repo ${repo.repo_id} ` +
        `(slug=${repo.slug}); previous URL omitted from log to avoid leaking ` +
        `any embedded credential. Canonical URL now: ${repo.remote_url}`
    );
  }
}

/**
 * Decide whether a `repos.patch` operation needs realignment.
 *
 * Exposed as a separate function so it can be unit-tested without a real
 * git repo. Fires only on the two operations that change what the canonical
 * URL is supposed to be:
 *
 *   1. The executor's `clone_status: 'ready'` patch after an initial clone
 *      completes. If the clone happened against a token-bearing URL, the
 *      on-disk config is tainted; realigning now wipes that.
 *   2. `updateMetadata()` flipping `remote_url` (e.g. via the
 *      `agor_repos_update` MCP tool). The DB row changes; on-disk should
 *      match it immediately.
 *
 * Skipped for unrelated patches (metadata-only updates, env-config
 * changes, etc.) to avoid spurious git work on every write.
 */
export function shouldRealignAfterRepoPatch(patchData: Partial<Repo> | undefined): boolean {
  if (!patchData) return false;
  const remoteUrlChanged = Object.hasOwn(patchData, 'remote_url');
  const cloneJustReady = patchData.clone_status === 'ready';
  return remoteUrlChanged || cloneJustReady;
}

/**
 * Feathers after-hook factory: realigns `remote.origin.url` after a
 * `repos.patch` that changed the canonical URL.
 *
 * Uses the byRepo variant since `context.result` already IS the patched
 * Repo row — no need for a second DB fetch. Fire-and-forget; failures are
 * logged and swallowed.
 *
 * Repo patches normally target a single row, but the hook tolerates
 * Feathers' Array-or-single result contract defensively.
 */
export function realignRepoOriginAfterPatchHook() {
  return async (context: HookContext): Promise<HookContext> => {
    const patchData = context.data as Partial<Repo> | undefined;
    if (!shouldRealignAfterRepoPatch(patchData)) return context;

    const result = context.result as Repo | Repo[] | undefined;
    if (!result) return context;

    const repos = Array.isArray(result) ? result : [result];
    for (const repo of repos) {
      if (!repo?.repo_id) continue;
      ensureRepoOriginAlignedForRepo(repo).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `⚠️  [repos.after.patch] ensureRepoOriginAlignedForRepo failed for repo ${repo.repo_id}: ${message}`
        );
      });
    }
    return context;
  };
}
