import type { CloneRepositoryResult } from '@agor/core/types';
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
  showInfo: (message: string, options?: { key?: string; duration?: number }) => unknown;
  showWarning: (message: string, options?: { key?: string; duration?: number }) => unknown;
}

/** Request feedback only. Durable clone outcomes belong to the repository view. */
export async function createRepository(
  client: AgorClient | null,
  data: CreateRepoRequest,
  options: CreateRepoOptions,
  { showError, showInfo, showWarning }: RepoNotifications,
  applyRepo: (repo: Repo) => void
) {
  if (options.shouldApply && !options.shouldApply()) return;
  if (!client) {
    if (!options.silent || options.showErrors) showError(notConnectedMessage('add the repository'));
    throw new Error(CLIENT_NOT_CONNECTED_ERROR);
  }

  const toastKey = `clone-repo-${data.slug}`;
  // Form submission owns busy state. Never leave a loading toast behind when
  // the form closes or its authenticated authority changes.
  let result: CloneRepositoryResult;
  try {
    result = await client.service('repos/clone').create({
      url: data.url,
      slug: data.slug,
      default_branch: data.default_branch,
    });
  } catch (error) {
    if (options.shouldApply && !options.shouldApply()) return;
    if (!options.silent || options.showErrors) {
      showError(
        isInFlightConnectionLossError(error)
          ? formatActionError('add the repository', error, { idempotent: false })
          : repositorySetupMessage(undefined, error),
        { key: toastKey }
      );
    }
    throw error;
  }
  if (options.shouldApply && !options.shouldApply()) return;

  // Hydrate a missed placeholder. applyRepo is the generation-fenced store
  // action: a stale GET must not overwrite a terminal realtime update.
  // A failed read after acceptance is not a failed clone request.
  if (result?.repo_id) {
    let repo: Repo;
    try {
      repo = await client.service('repos').get(result.repo_id);
    } catch {
      if (options.shouldApply && !options.shouldApply()) return;
      if (!options.silent || options.showErrors) {
        showWarning(
          'Repository request accepted, but its status could not be refreshed. Check Settings → Repos.',
          { key: toastKey, duration: 4 }
        );
      }
      return result;
    }
    if (options.shouldApply && !options.shouldApply()) return;
    applyRepo(repo);
  }

  if (!options.silent) {
    showInfo(
      result?.status === 'exists'
        ? `Repository "${data.slug}" is already registered. Check Settings → Repos for status.`
        : `Repository clone started for ${data.slug}. Check Settings → Repos for status.`,
      { key: toastKey, duration: 3 }
    );
  }
  return result;
}
