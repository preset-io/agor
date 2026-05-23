import type { Artifact, Session, Worktree } from '@agor-live/client';
import { useMemo } from 'react';
import type { SearchResultItem } from '../components/GlobalSearch/types';

interface UseRecentsInput {
  currentUserId?: string;
  sessionById: Map<string, Session>;
  worktreeById: Map<string, Worktree>;
  artifactById: Map<string, Artifact>;
}

const RECENT_SESSION_LIMIT = 5;
const RECENT_WORKTREE_LIMIT = 3;
const RECENT_ARTIFACT_LIMIT = 2;

/**
 * Backend-free recents — "stuff I created, most-recently-updated first."
 *
 * Sources directly from the in-memory entity maps that useAgorData keeps
 * WebSocket-synced. No localStorage, no new schema. Per design doc §3.2.
 *
 * Sessions dominate because they're the highest-churn surface and most likely
 * what the user is looking for when they pop the dropdown open.
 */
export function useRecents({
  currentUserId,
  sessionById,
  worktreeById,
  artifactById,
}: UseRecentsInput): SearchResultItem[] {
  return useMemo(() => {
    if (!currentUserId) return [];

    const sessions = Array.from(sessionById.values())
      .filter((s) => s.created_by === currentUserId)
      .sort(byUpdatedAt)
      .slice(0, RECENT_SESSION_LIMIT)
      .map<SearchResultItem>((s) => ({
        type: 'session',
        item: s,
        parentWorktree: worktreeById.get(s.worktree_id),
      }));

    const worktrees = Array.from(worktreeById.values())
      .filter((w) => w.created_by === currentUserId)
      .sort(byUpdatedAt)
      .slice(0, RECENT_WORKTREE_LIMIT)
      .map<SearchResultItem>((w) => {
        const isAssistant = Boolean(w.custom_context?.assistant ?? w.custom_context?.agent);
        return isAssistant
          ? { type: 'assistant', item: w }
          : { type: 'worktree', item: w };
      });

    const artifacts = Array.from(artifactById.values())
      .filter((a) => a.created_by === currentUserId)
      .sort(byUpdatedAt)
      .slice(0, RECENT_ARTIFACT_LIMIT)
      .map<SearchResultItem>((a) => ({
        type: 'artifact',
        item: a,
        parentWorktree: a.worktree_id ? worktreeById.get(a.worktree_id) : undefined,
      }));

    // Interleave with sessions first (highest signal), then worktrees, then artifacts —
    // matches the section order in the design doc but flattened for the Recents view.
    return [...sessions, ...worktrees, ...artifacts];
  }, [currentUserId, sessionById, worktreeById, artifactById]);
}

function byUpdatedAt(a: { updated_at?: string }, b: { updated_at?: string }): number {
  const at = a.updated_at ?? '';
  const bt = b.updated_at ?? '';
  return bt.localeCompare(at);
}
