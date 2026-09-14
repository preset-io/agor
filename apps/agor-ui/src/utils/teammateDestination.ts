import {
  type AgorClient,
  normalizeRepoUrl,
  type Repo,
  TEAMMATE_FRAMEWORK_REPO_URL,
} from '@agor-live/client';

function isPublicStarter(url: string): boolean {
  const remote = normalizeRepoUrl(url)
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://');
  return remote.toLowerCase() === normalizeRepoUrl(TEAMMATE_FRAMEWORK_REPO_URL).toLowerCase();
}

/** Readiness is not upstream authorization or visibility. Never infer those from a name. */
export function destinationProblem(repo: Repo | undefined): string | undefined {
  if (!repo) return 'Choose a registered repository for your teammate.';
  if (!repo.remote_url)
    return 'This repository has no remote destination. Choose one with a remote URL.';
  if (isPublicStarter(repo.remote_url)) {
    return 'The public starter is a source, not your destination. Add a repository you control.';
  }
  if (repo.clone_status === 'cloning')
    return 'Cloning this repository. Keep this screen open or return later.';
  if (repo.clone_status === 'failed') {
    switch (repo.clone_error?.category) {
      case 'auth_failed':
        return 'Repository sign-in failed. Check your repository credentials and retry.';
      case 'not_found':
        return 'Repository not found or not accessible to your credentials. Check the URL and access.';
      case 'network':
        return 'Could not reach the repository. Check the connection and retry.';
      default:
        return 'Repository cloning failed. Check the URL and retry.';
    }
  }
  return undefined;
}

/** Reject secrets before the URL can enter drafts, logs or service error messages. */
export function validateDestinationUrl(value: string): string {
  const url = value.trim();
  if (
    !/^https:\/\/[\w.-]+(?::\d+)?\/[\w./-]+$/.test(url) &&
    !/^(?:ssh:\/\/)?git@[\w.-]+[:/][\w./-]+$/.test(url)
  ) {
    throw new Error(
      'Paste an HTTPS or SSH repository URL without a token, password, or query string.'
    );
  }
  if (isPublicStarter(url)) {
    throw new Error('Add your own repository, not the public starter source.');
  }
  return url;
}

/** Poll the exact authenticated service ID, never a framework-name heuristic or shared auth cache. */
export async function waitForDestinationReady(
  client: AgorClient,
  repoId: string,
  isCurrent: () => boolean,
  deadlineMs = 20_000
): Promise<Repo> {
  const deadline = Date.now() + deadlineMs;
  do {
    if (!isCurrent()) throw new Error('Setup was cancelled.');
    const repo = await client.service('repos').get(repoId);
    if (!isCurrent()) throw new Error('Setup was cancelled.');
    if (repo.repo_id !== repoId) throw new Error('The destination returned an unexpected ID.');
    if (repo.clone_status !== 'cloning') {
      const problem = destinationProblem(repo);
      if (problem) throw new Error(problem);
      return repo;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() <= deadline);
  throw new Error(
    'This repository is still cloning. Return to its home screen and retry when ready.'
  );
}
