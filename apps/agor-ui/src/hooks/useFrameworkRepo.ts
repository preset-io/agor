import type { Repo } from '@agor-live/client';
import { useMemo } from 'react';

export const FRAMEWORK_REPO_SLUG = 'preset-io/agor-assistant';
export const FRAMEWORK_REPO_URL = 'https://github.com/preset-io/agor-assistant.git';

/**
 * Match predicate with priority ordering:
 * 1. agor-assistant-private (any org) — private fork takes precedence
 * 2. preset-io/agor-assistant (exact slug)
 * 3. Any repo whose remote_url contains "agor-assistant"
 * 4. Any repo whose remote_url contains "agor-openclaw" (legacy)
 */
function findBestFrameworkRepo(repos: Repo[]): Repo | undefined {
  let publicMatch: Repo | undefined;
  let urlMatch: Repo | undefined;

  for (const r of repos) {
    // Highest priority: private fork
    if (
      r.slug?.includes('agor-assistant-private') ||
      r.remote_url?.includes('agor-assistant-private')
    ) {
      return r;
    }
    // Exact public slug
    if (!publicMatch && r.slug === FRAMEWORK_REPO_SLUG) {
      publicMatch = r;
    }
    // URL-based fallback
    if (
      !urlMatch &&
      (r.remote_url?.includes('agor-assistant') || r.remote_url?.includes('agor-openclaw'))
    ) {
      urlMatch = r;
    }
  }

  return publicMatch || urlMatch;
}

/**
 * Detects the framework repository from a list of repos.
 * Prefers agor-assistant-private over the public repo.
 * Used by AssistantTab, AssistantsTable, and OnboardingWizard.
 */
export function useFrameworkRepo(repos: Repo[]): Repo | undefined {
  return useMemo(() => findBestFrameworkRepo(repos), [repos]);
}

/**
 * Non-hook version for use in loops / imperative code (e.g., OnboardingWizard effects).
 *
 * When `readyOnly` is true, non-ready repos (`clone_status: 'cloning' | 'failed'`) are
 * excluded **before** priority selection, so a stale/failed higher-priority match (e.g.
 * an abandoned `agor-assistant-private` clone) never hides a ready lower-priority repo.
 */
export function findFrameworkRepo(
  repos: Iterable<[string, Repo]>,
  options?: { readyOnly?: boolean }
): [string, Repo] | undefined {
  const repoArray: Repo[] = [];
  const entryMap = new Map<string, [string, Repo]>();

  for (const entry of repos) {
    const repo = entry[1];
    if (options?.readyOnly && repo.clone_status !== 'ready' && repo.clone_status !== undefined) {
      continue;
    }
    repoArray.push(repo);
    entryMap.set(repo.repo_id, entry);
  }

  const best = findBestFrameworkRepo(repoArray);
  if (best) {
    return entryMap.get(best.repo_id);
  }
  return undefined;
}
