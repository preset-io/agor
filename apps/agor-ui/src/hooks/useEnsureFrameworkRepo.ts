import type { CreateRepoRequest, Repo } from '@agor-live/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { repositorySetupMessage } from '../utils/repositorySetupMessage';
import { FRAMEWORK_REPO_SLUG, FRAMEWORK_REPO_URL, findFrameworkRepo } from './useFrameworkRepo';

const CLONE_TIMEOUT_MS = 120_000;

/** Optional prefetch. Failed setup is status, not success or an automatic retry loop. */
export function useEnsureFrameworkRepo(
  repos: Repo[],
  onCreateRepo?: (data: CreateRepoRequest) => unknown,
  { enabled = true, ownerKey }: { enabled?: boolean; ownerKey?: unknown } = {}
): { frameworkRepo: Repo | undefined; isCloning: boolean; error?: string } {
  const entries = useMemo(() => new Map(repos.map((repo) => [repo.repo_id, repo])), [repos]);
  const ready = findFrameworkRepo(entries, { readyOnly: true })?.[1];
  const registered = ready ?? findFrameworkRepo(entries)?.[1];
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState<string>();
  const triggered = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: an authenticated owner or activation change retires the previous prefetch
  useEffect(() => {
    triggered.current = false;
    setError(undefined);
    setIsCloning(false);
  }, [ownerKey, enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ownerKey retires in-flight continuations even if the selected repo is unchanged
  useEffect(() => {
    if (!enabled) return;
    if (ready) {
      setIsCloning(false);
      setError(undefined);
      return;
    }
    if (registered?.clone_status === 'failed') {
      setIsCloning(false);
      setError(repositorySetupMessage(registered));
      return;
    }
    if (!registered && !onCreateRepo) return;
    let active = true;
    setIsCloning(true);
    const timer = setTimeout(() => {
      if (!active) return;
      setIsCloning(false);
      setError(repositorySetupMessage({ clone_status: 'cloning' }));
    }, CLONE_TIMEOUT_MS);
    if (!registered && onCreateRepo && !triggered.current) {
      void Promise.resolve()
        .then(() => {
          if (!active) return;
          triggered.current = true;
          return onCreateRepo({
            url: FRAMEWORK_REPO_URL,
            slug: FRAMEWORK_REPO_SLUG,
            default_branch: 'main',
          });
        })
        .catch((err: unknown) => {
          if (!active) return;
          clearTimeout(timer);
          setIsCloning(false);
          setError(repositorySetupMessage(undefined, err));
          // No raw provider diagnostic or identity in the browser log. Persisted
          // clone_error and executor logs retain redacted operator details.
          console.warn('[onboarding] Repository prefetch failed; required setup can be retried.');
        });
    }
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, ownerKey, ready, registered, onCreateRepo]);

  return {
    frameworkRepo: ready,
    isCloning: enabled && isCloning,
    error: enabled ? error : undefined,
  };
}
