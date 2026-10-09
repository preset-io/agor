import type { AgorClient, CreateRepoRequest, Repo } from '@agor-live/client';
import type { CreateRepoOptions } from '../types';
import {
  CLIENT_NOT_CONNECTED_ERROR,
  formatActionError,
  isInFlightConnectionLossError,
  notConnectedMessage,
} from './connectionErrors';
import { repositorySetupMessage } from './repositorySetupMessage';

interface RepoNotifications {
  showError: (message: string, options?: { key?: string }) => unknown;
  showLoading: (message: string, options?: { key?: string }) => unknown;
  showSuccess: (message: string, options?: { key?: string }) => unknown;
  showWarning: (message: string, options?: { key?: string; duration?: number }) => unknown;
}

/** Background callers own status; explicit Add Repository callers get notifications. */
export async function createRepository(
  client: AgorClient | null,
  data: CreateRepoRequest,
  options: CreateRepoOptions,
  { showError, showLoading, showSuccess, showWarning }: RepoNotifications,
  applyRepo: (repo: Repo) => void
) {
  if (options.shouldApply && !options.shouldApply()) return;
  if (!client) {
    if (!options.silent || options.showErrors) showError(notConnectedMessage('add the repository'));
    throw new Error(CLIENT_NOT_CONNECTED_ERROR);
  }

  // POST /repos/clone returns `{ status: 'pending', repo_id }` immediately;
  // the daemon pre-creates the repo row with `clone_status: 'cloning'` and
  // the executor patches it to `'ready'`/`'failed'`. Listen for `patched`
  // (the durable outcome) — `created` only fires for the placeholder now,
  // unless the row is a legacy `create_local` (no `clone_status`).
  // `repo:cloneError` is kept as a belt-and-suspenders fallback so older
  // executors that don't patch still surface failures.
  const toastKey = `clone-repo-${data.slug}`;
  const CLONE_TIMEOUT_MS = 120_000;
  if (!options.silent) showLoading(`Cloning ${data.slug}...`, { key: toastKey });

  const reposService = client.service('repos');
  let settled = false;
  let accepted: Repo | undefined;
  let earlyOutcome: Repo | undefined;
  const rememberEarlyOutcome = (repo: Repo) => {
    if (accepted || repo.slug !== data.slug || repo.clone_status === 'cloning') return;
    if (!earlyOutcome || (repo.clone_generation ?? 0) >= (earlyOutcome.clone_generation ?? 0))
      earlyOutcome = repo;
  };
  const isCurrentClone = (repo: Repo) =>
    !!accepted &&
    repo.repo_id === accepted.repo_id &&
    (repo.clone_generation ?? 0) === (accepted.clone_generation ?? 0);

  const cleanup = () => {
    reposService.removeListener('created', handleCreated);
    reposService.removeListener('patched', handlePatched);
    client.io.off('repo:cloneError', handleCloneError);
    clearTimeout(timeoutHandle);
  };
  const handleCreated = (repo: Repo) => {
    rememberEarlyOutcome(repo);
    if (settled || !isCurrentClone(repo)) return;
    if (options.shouldApply && !options.shouldApply()) {
      settled = true;
      cleanup();
      return;
    }
    // Skip the `'cloning'` placeholder — `handlePatched` will declare the
    // outcome once the executor finishes. `undefined` covers legacy rows
    // and any direct executor-path that bypasses the placeholder.
    if (repo.clone_status === 'cloning') return;
    if (repo.clone_status === 'failed') {
      handlePatched(repo);
      return;
    }
    settled = true;
    if (!options.silent) showSuccess(`Cloned ${data.slug}`, { key: toastKey });
    cleanup();
  };
  const handlePatched = (repo: Repo) => {
    rememberEarlyOutcome(repo);
    if (settled || !isCurrentClone(repo)) return;
    if (options.shouldApply && !options.shouldApply()) {
      settled = true;
      cleanup();
      return;
    }
    if (repo.clone_status === 'ready') {
      settled = true;
      if (!options.silent) showSuccess(`Cloned ${data.slug}`, { key: toastKey });
      cleanup();
    } else if (repo.clone_status === 'failed') {
      settled = true;
      // Keep raw diagnostics on the repo; notifications contain safe remediation.
      if (!options.silent || options.showErrors) {
        showError(repositorySetupMessage(repo), {
          key: toastKey,
        });
      }
      cleanup();
    }
  };
  const handleCloneError = (payload: {
    slug?: string;
    url?: string;
    error?: string;
    clone_error?: Repo['clone_error'];
  }) => {
    // Modern workers report durable, generation-fenced repo events. Raw legacy
    // errors cannot be attributed to an in-place retry and must not override it.
    if (settled || !accepted || accepted.clone_generation) return;
    if (options.shouldApply && !options.shouldApply()) {
      settled = true;
      cleanup();
      return;
    }
    if (payload.slug !== data.slug && payload.url !== data.url) return;
    settled = true;
    if (!options.silent || options.showErrors) {
      showError(
        repositorySetupMessage({ clone_status: 'failed', clone_error: payload.clone_error }),
        { key: toastKey }
      );
    }
    cleanup();
  };
  const timeoutHandle = setTimeout(() => {
    if (settled) return;
    if (options.shouldApply && !options.shouldApply()) {
      settled = true;
      cleanup();
      return;
    }
    settled = true;
    if (!options.silent || options.showErrors) {
      showWarning(
        'Repository setup is taking longer than expected. Check Repository settings before you try again.',
        { key: toastKey, duration: 0 }
      );
    }
    cleanup();
  }, CLONE_TIMEOUT_MS);

  reposService.on('created', handleCreated);
  reposService.on('patched', handlePatched);
  client.io.on('repo:cloneError', handleCloneError);

  try {
    const result = await client.service('repos/clone').create({
      url: data.url,
      slug: data.slug,
      default_branch: data.default_branch,
    });
    if (options.shouldApply && !options.shouldApply()) {
      settled = true;
      cleanup();
      return;
    }

    // Hydrate even when this client missed created/patched, or another caller
    // won the registration race. Registration alone is never clone success.
    if (result?.repo_id) {
      let repo = await reposService.get(result.repo_id);
      if (options.shouldApply && !options.shouldApply()) {
        settled = true;
        cleanup();
        return;
      }
      accepted = repo;
      // A terminal event can arrive while GET is returning an older cloning
      // snapshot. Retain it, but only for the registration/attempt GET identified.
      if (earlyOutcome && isCurrentClone(earlyOutcome)) repo = earlyOutcome;
      applyRepo(repo);
      if (repo.clone_status === 'failed') handlePatched(repo);
      else if (repo.clone_status === 'ready' || !repo.clone_status) {
        if (result.status === 'exists' && !settled) {
          settled = true;
          if (!options.silent)
            showWarning(`Repository "${data.slug}" is already added`, { key: toastKey });
          cleanup();
        } else handleCreated(repo);
      }
      // An existing cloning row stays pending until a terminal event/timeout.
    }
    return result;
  } catch (error) {
    if (options.shouldApply && !options.shouldApply()) {
      settled = true;
      cleanup();
      return;
    }
    if (!settled) {
      settled = true;
      if (!options.silent || options.showErrors) {
        showError(
          isInFlightConnectionLossError(error)
            ? formatActionError('add the repository', error, { idempotent: false })
            : repositorySetupMessage(undefined, error),
          { key: toastKey }
        );
      }
      cleanup();
    }
    throw error;
  }
}
