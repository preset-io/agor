import type { Repo } from '@agor/core/types';
import { useEffect, useRef, useState } from 'react';
import { FRAMEWORK_REPO_SLUG, FRAMEWORK_REPO_URL, useFrameworkRepo } from './useFrameworkRepo';

/**
 * Wraps useFrameworkRepo with auto-clone behavior: if the framework repo
 * is not registered, triggers a clone via onCreateRepo. The clone is
 * fire-and-forget — the repo will appear in the repo list via WebSocket
 * once the executor finishes.
 *
 * Returns the framework repo (once available) and a cloning flag for UI feedback.
 */
export function useEnsureFrameworkRepo(
  repos: Repo[],
  onCreateRepo?: (data: { url: string; slug: string; default_branch: string }) => void
): { frameworkRepo: Repo | undefined; isCloning: boolean } {
  const frameworkRepo = useFrameworkRepo(repos);
  const [isCloning, setIsCloning] = useState(false);
  const cloneTriggeredRef = useRef(false);

  useEffect(() => {
    // Already found — nothing to do
    if (frameworkRepo) {
      setIsCloning(false);
      return;
    }

    // No callback to trigger clone, or already triggered
    if (!onCreateRepo || cloneTriggeredRef.current) return;

    // Trigger auto-clone once
    cloneTriggeredRef.current = true;
    setIsCloning(true);

    onCreateRepo({
      url: FRAMEWORK_REPO_URL,
      slug: FRAMEWORK_REPO_SLUG,
      default_branch: 'main',
    });
  }, [frameworkRepo, onCreateRepo]);

  return { frameworkRepo, isCloning: isCloning && !frameworkRepo };
}
