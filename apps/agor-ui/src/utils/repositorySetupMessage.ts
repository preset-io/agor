import type { Repo } from '@agor-live/client';

/** User copy never interpolates raw Git stderr, paths, URLs or credential diagnostics. */
export function repositorySetupMessage(
  repo?: Pick<Repo, 'clone_status' | 'clone_error'>,
  requestError?: unknown
): string {
  const code = (requestError as { code?: number } | undefined)?.code;
  if (code === 408)
    return "Agor hasn't confirmed repository setup yet. Check Repository settings before you try again.";
  if (code === 409)
    return 'This repository name is already registered with another source. Choose a different name, or ask an administrator to check the existing repository.';
  if (code === 401) return 'Reconnect to Agor, then try setting up the workspace again.';
  if (code === 403)
    return 'Your account cannot set up this repository. Ask a workspace administrator to check your access, then try again.';
  if (repo?.clone_status === 'cloning') {
    return 'The workspace is still being prepared. Wait a moment, then try again.';
  }
  switch (repo?.clone_error?.category) {
    case 'auth_failed':
      return 'Agor could not access the repository with your Git credentials. Check your repository access and Git connection, then try again.';
    case 'not_found':
      return 'The repository or its source branch could not be found. Ask an administrator to check the repository URL, branch and access, then try again.';
    case 'network':
      return "Agor couldn't reach the repository securely. If this keeps happening, ask an administrator to check network and certificate settings.";
    case 'git_unavailable':
      return "Agor can't run Git right now. Ask an administrator to fix it.";
    default:
      return "The repository couldn't be prepared, but your existing work wasn't removed. Try again, or ask an administrator if it keeps happening.";
  }
}
