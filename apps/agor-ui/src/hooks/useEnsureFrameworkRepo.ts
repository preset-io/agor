import type { Repo } from '@agor/core/types';
import { useEffect, useRef, useState } from 'react';
import { FRAMEWORK_REPO_SLUG, FRAMEWORK_REPO_URL, useFrameworkRepo } from './useFrameworkRepo';

/** If the repo hasn't appeared after this long, assume the clone failed. */
const CLONE_TIMEOUT_MS = 120_000;

/**
 * Wraps useFrameworkRepo with auto-clone behavior: if the framework repo
 * is not registered, triggers a clone via onCreateRepo. The clone is
 * fire-and-forget — the repo will appear in the repo list via WebSocket
 * once the executor finishes.
 *
 * Pass `enabled: false` to defer the auto-clone until the caller is ready
 * (e.g., until a create-modal is opened).
 *
 * Returns the framework repo (once available) and a cloning flag for UI feedback.
 */
export function useEnsureFrameworkRepo(
  repos: Repo[],
  onCreateRepo?: (data: { url: string; slug: string; default_branch: string }) => void,
  { enabled = true }: { enabled?: boolean } = {}
): { frameworkRepo: Repo | undefined; isCloning: boolean } {
  const frameworkRepo = useFrameworkRepo(repos);
  const [isCloning, setIsCloning] = useState(false);
  const cloneTriggeredRef = useRef(false);

  useEffect(() => {
    // Already found — nothing to do
    if (frameworkRepo) {
      setIsCloning(false);
      cloneTriggeredRef.current = false;
      return;
    }

    // Not enabled yet, no callback, or already triggered
    if (!enabled || !onCreateRepo || cloneTriggeredRef.current) return;

    // Trigger auto-clone once
    cloneTriggeredRef.current = true;
    setIsCloning(true);

    onCreateRepo({
      url: FRAMEWORK_REPO_URL,
      slug: FRAMEWORK_REPO_SLUG,
      default_branch: 'main',
    });

    // Safety timeout — if repo never appears, clear the loading state
    // so the user can pick an alternate repo or retry on next open.
    const timer = setTimeout(() => {
      setIsCloning(false);
      cloneTriggeredRef.current = false;
    }, CLONE_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [frameworkRepo, onCreateRepo, enabled]);

  // Reset when disabled (e.g., modal closed) so next open can retry
  useEffect(() => {
    if (!enabled && !frameworkRepo) {
      cloneTriggeredRef.current = false;
    }
  }, [enabled, frameworkRepo]);

  return { frameworkRepo, isCloning: isCloning && !frameworkRepo };
}
