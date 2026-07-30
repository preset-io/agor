import { readLocalStorageJson } from '../hooks/localStorageJson';
import { writeSharedLocalStorageJson } from '../hooks/useLocalStorage';

/**
 * Exceptions-only collapse store for branch cards on boards.
 *
 * Every collapsible node on a branch card — the top-level sections and the
 * parent sessions in the genealogy tree — is expanded by default. Only
 * user-collapsed exceptions are stored, keyed by branch id under a single
 * localStorage entry:
 *
 *   collapsedBranchNodes[branchId] = {
 *     sections: ['sessions', 'scheduled-runs'],
 *     sessionIds: [parentSessionId],
 *   }
 *
 * Entries survive branch archive/unarchive and board moves; they are redacted
 * only when the branch is hard-deleted (see `branchRemoved` in
 * `store/agorRealtimeActions.ts`).
 */
export const COLLAPSED_BRANCH_NODES_STORAGE_KEY = 'agor:board:collapsed-branch-nodes';

export type BranchSectionKey = 'sessions' | 'scheduled-runs' | 'gateway-sessions';

export interface CollapsedBranchNode {
  sections?: BranchSectionKey[];
  sessionIds?: string[];
}

export type CollapsedBranchNodes = Record<string, CollapsedBranchNode>;

export const EMPTY_COLLAPSED_BRANCH_NODES: CollapsedBranchNodes = {};
export const EMPTY_COLLAPSED_BRANCH_NODE: CollapsedBranchNode = {};

/**
 * Return `nodes` with the branch's entry replaced by `node`, dropping empty
 * arrays and whole entries so the store only ever holds real exceptions.
 */
export function setCollapsedBranchNode(
  nodes: CollapsedBranchNodes,
  branchId: string,
  node: CollapsedBranchNode
): CollapsedBranchNodes {
  const sections = node.sections?.length ? node.sections : undefined;
  const sessionIds = node.sessionIds?.length ? node.sessionIds : undefined;

  if (!sections && !sessionIds) {
    if (!(branchId in nodes)) return nodes;
    const { [branchId]: _removed, ...rest } = nodes;
    return rest;
  }

  return {
    ...nodes,
    [branchId]: {
      ...(sections ? { sections } : {}),
      ...(sessionIds ? { sessionIds } : {}),
    },
  };
}

/** Read one branch's collapse exceptions straight from localStorage. */
export function readCollapsedBranchNode(branchId: string): CollapsedBranchNode {
  const nodes = readLocalStorageJson<CollapsedBranchNodes>(
    COLLAPSED_BRANCH_NODES_STORAGE_KEY,
    EMPTY_COLLAPSED_BRANCH_NODES
  );
  return nodes[branchId] ?? EMPTY_COLLAPSED_BRANCH_NODE;
}

/**
 * Redact a hard-deleted branch's collapse exceptions. Writes through the
 * shared localStorage channel so any mounted `useLocalStorage` consumers of
 * the store stay in sync.
 */
export function removeCollapsedBranchNode(branchId: string): void {
  const nodes = readLocalStorageJson<CollapsedBranchNodes>(
    COLLAPSED_BRANCH_NODES_STORAGE_KEY,
    EMPTY_COLLAPSED_BRANCH_NODES
  );
  if (!(branchId in nodes)) return;
  writeSharedLocalStorageJson(
    COLLAPSED_BRANCH_NODES_STORAGE_KEY,
    setCollapsedBranchNode(nodes, branchId, EMPTY_COLLAPSED_BRANCH_NODE)
  );
}
