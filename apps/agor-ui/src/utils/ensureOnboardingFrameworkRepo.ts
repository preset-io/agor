import type { CreateRepoRequest, Repo } from '@agor-live/client';
import {
  FRAMEWORK_REPO_SLUG,
  FRAMEWORK_REPO_URL,
  findFrameworkRepo,
} from '../hooks/useFrameworkRepo';
import { repositorySetupMessage } from './repositorySetupMessage';
import {
  type WaitForFrameworkRepoReadyOptions,
  waitForFrameworkRepoReady,
} from './waitForFrameworkRepoReady';

async function beforeDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject({ code: 408 }), deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The named-teammate completion step is required, unlike optional background prefetch. */
export async function ensureOnboardingFrameworkRepo(
  options: WaitForFrameworkRepoReadyOptions & {
    createRepo: (data: CreateRepoRequest) => Promise<unknown>;
    isCurrent: () => boolean;
  }
): Promise<Repo | undefined> {
  if (!options.isCurrent()) return;
  let repos: Repo[];
  try {
    repos = await beforeDeadline(options.fetchRepos(), options.deadlineMs);
  } catch (error) {
    throw new Error(repositorySetupMessage(undefined, error));
  }
  if (!options.isCurrent()) return;
  const entries = new Map(repos.map((repo) => [repo.repo_id, repo]));
  const ready = findFrameworkRepo(entries, { readyOnly: true })?.[1];
  const registered = ready ?? findFrameworkRepo(entries)?.[1];
  if (registered) options.applyRepo(registered);
  if (ready) return ready;
  if (!registered || registered.clone_status === 'failed') {
    try {
      await beforeDeadline(
        options.createRepo({
          url: registered?.remote_url ?? FRAMEWORK_REPO_URL,
          slug: registered?.slug ?? FRAMEWORK_REPO_SLUG,
          default_branch: registered?.default_branch ?? 'main',
        }),
        options.deadlineMs
      );
    } catch (error) {
      throw new Error(repositorySetupMessage(undefined, error));
    }
  }
  if (!options.isCurrent()) return;
  const result = await waitForFrameworkRepoReady({ ...options, isCurrent: options.isCurrent });
  if (!options.isCurrent()) return;
  if (!result)
    throw new Error(repositorySetupMessage(findFrameworkRepo(options.getRepoById())?.[1]));
  return result;
}
