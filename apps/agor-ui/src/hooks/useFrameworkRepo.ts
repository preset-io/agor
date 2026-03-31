import type { Repo } from '@agor/core/types';
import { useMemo } from 'react';

export const FRAMEWORK_REPO_SLUG = 'preset-io/agor-assistant';

/**
 * Detects the framework repository (preset-io/agor-assistant or forks/derivatives)
 * from a list of repos. Used by AssistantTab, AssistantsTable, and OnboardingWizard.
 */
export function useFrameworkRepo(repos: Repo[]): Repo | undefined {
  return useMemo(
    () =>
      repos.find(
        (r) =>
          r.slug === FRAMEWORK_REPO_SLUG ||
          r.remote_url?.includes('agor-assistant') ||
          r.remote_url?.includes('agor-openclaw')
      ),
    [repos]
  );
}

/**
 * Non-hook version for use in loops / imperative code (e.g., OnboardingWizard effects).
 */
export function findFrameworkRepo(repos: Iterable<[string, Repo]>): [string, Repo] | undefined {
  for (const entry of repos) {
    const repo = entry[1];
    if (
      repo.slug === FRAMEWORK_REPO_SLUG ||
      repo.remote_url?.includes('agor-assistant') ||
      repo.remote_url?.includes('agor-openclaw')
    ) {
      return entry;
    }
  }
  return undefined;
}
