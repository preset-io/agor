import type { Artifact, Branch, Session } from '@agor-live/client';
import { isAssistant } from '@agor-live/client';
import { useMemo } from 'react';
import type { SearchResultItem } from './types';
import { tsValue } from './utils';

interface UseRecentsInput {
  currentUserId?: string;
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
  artifactById: Map<string, Artifact>;
}

const RECENT_SESSION_LIMIT = 5;
const RECENT_BRANCH_LIMIT = 3;
const RECENT_ARTIFACT_LIMIT = 2;

/**
 * Backend-free recents — "stuff I created."
 *
 * Sources directly from the in-memory entity maps that useAgorData keeps
 * WebSocket-synced. No localStorage, no new schema. Per design doc §3.2.
 *
 * Note: recents are **section-biased** by entity type (5 sessions / 3 branches /
 * 2 artifacts) and concatenated in that order — NOT globally sorted by recency.
 * Sessions are the highest-churn / highest-signal surface, so we always lead
 * with them even when a recently-updated branch edges out the 5th-place session
 * on raw timestamp. If we ever want true global ordering, merge the three lists
 * and re-sort by their per-entity timestamp before slicing.
 */
export function useRecents({
  currentUserId,
  sessionById,
  branchById,
  artifactById,
}: UseRecentsInput): SearchResultItem[] {
  return useMemo(() => {
    if (!currentUserId) return [];

    const sessions = Array.from(sessionById.values())
      .filter((s) => s.created_by === currentUserId)
      .sort((a, b) => tsValue(b.last_updated) - tsValue(a.last_updated))
      .slice(0, RECENT_SESSION_LIMIT)
      .map<SearchResultItem>((s) => ({
        type: 'session',
        item: s,
        parentBranch: branchById.get(s.branch_id),
      }));

    const branches = Array.from(branchById.values())
      .filter((w) => w.created_by === currentUserId)
      .sort((a, b) => tsValue(b.updated_at) - tsValue(a.updated_at))
      .slice(0, RECENT_BRANCH_LIMIT)
      .map<SearchResultItem>((w) =>
        isAssistant(w) ? { type: 'assistant', item: w } : { type: 'branch', item: w }
      );

    const artifacts = Array.from(artifactById.values())
      .filter((a) => !a.archived)
      .filter((a) => a.created_by === currentUserId)
      .sort((a, b) => tsValue(b.updated_at) - tsValue(a.updated_at))
      .slice(0, RECENT_ARTIFACT_LIMIT)
      .map<SearchResultItem>((a) => ({
        type: 'artifact',
        item: a,
        parentBranch: a.branch_id ? branchById.get(a.branch_id) : undefined,
      }));

    return [...sessions, ...branches, ...artifacts];
  }, [currentUserId, sessionById, branchById, artifactById]);
}
