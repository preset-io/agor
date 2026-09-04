import type { Session } from '@agor/core/types';

export type SessionArchiveReason = NonNullable<Session['archived_reason']>;

export type SessionArchiveTarget = {
  session: Session;
  archived: boolean;
  archivedReason: SessionArchiveReason | null;
};

export const MANUAL_ARCHIVED_REASON = 'manual' satisfies SessionArchiveReason;
export const PARENT_ARCHIVED_REASON = 'parent_archived' satisfies SessionArchiveReason;
export const BTW_ARCHIVED_REASON = 'btw_completed' satisfies SessionArchiveReason;
export const BRANCH_ARCHIVED_REASON = 'branch_archived' satisfies SessionArchiveReason;

function needsArchiveWrite(
  session: Session,
  archived: boolean,
  archivedReason: SessionArchiveReason | null
): boolean {
  if (session.archived !== archived) return true;
  if (!archived) return session.archived_reason !== undefined;
  return session.archived_reason !== archivedReason;
}

/**
 * Plan one branch-local tree transition while preserving independently-owned
 * archive causes. Remote relationships are intentionally absent from the
 * input: they are provenance, not canonical genealogy.
 */
export function planSessionTreeArchiveTransition(input: {
  root: Session;
  descendants: Session[];
  archived: boolean;
  rootReason: SessionArchiveReason;
}): SessionArchiveTarget[] {
  const { root, descendants, archived, rootReason } = input;
  const targets: SessionArchiveTarget[] = [];

  if (archived) {
    // An explicit operation promotes a row that was hidden only because of a
    // parent into an independently archived root. Other independent causes
    // stay owned by their original lifecycle.
    if (
      (!root.archived || root.archived_reason === PARENT_ARCHIVED_REASON) &&
      needsArchiveWrite(root, true, rootReason)
    ) {
      targets.push({ session: root, archived: true, archivedReason: rootReason });
    }
    for (const session of descendants) {
      if (!session.archived && needsArchiveWrite(session, true, PARENT_ARCHIVED_REASON)) {
        targets.push({
          session,
          archived: true,
          archivedReason: PARENT_ARCHIVED_REASON,
        });
      }
    }
    return targets;
  }

  if (root.archived || root.archived_reason !== undefined) {
    targets.push({ session: root, archived: false, archivedReason: null });
  }

  // An independently archived intermediate node still covers its subtree.
  // Do not revive a deeper `parent_archived` row through that boundary.
  const remainingArchived = new Set(
    descendants
      .filter((session) => session.archived && session.archived_reason !== PARENT_ARCHIVED_REASON)
      .map((session) => session.session_id)
  );
  let discoveredCoveredDescendant = true;
  while (discoveredCoveredDescendant) {
    discoveredCoveredDescendant = false;
    for (const session of descendants) {
      if (
        !session.archived ||
        session.archived_reason !== PARENT_ARCHIVED_REASON ||
        remainingArchived.has(session.session_id)
      ) {
        continue;
      }
      const parentIds = [
        session.genealogy?.parent_session_id,
        session.genealogy?.forked_from_session_id,
      ];
      if (parentIds.some((parentId) => parentId && remainingArchived.has(parentId))) {
        remainingArchived.add(session.session_id);
        discoveredCoveredDescendant = true;
      }
    }
  }
  for (const session of descendants) {
    if (
      session.archived_reason === PARENT_ARCHIVED_REASON &&
      !remainingArchived.has(session.session_id) &&
      needsArchiveWrite(session, false, null)
    ) {
      targets.push({ session, archived: false, archivedReason: null });
    }
  }
  return targets;
}

export function planBranchArchiveTransition(sessions: Session[]): SessionArchiveTarget[] {
  return sessions
    .filter((session) => !session.archived)
    .map((session) => ({
      session,
      archived: true,
      archivedReason: BRANCH_ARCHIVED_REASON,
    }));
}

export function planBranchUnarchiveTransition(sessions: Session[]): SessionArchiveTarget[] {
  return sessions
    .filter((session) => session.archived && session.archived_reason === BRANCH_ARCHIVED_REASON)
    .map((session) => ({ session, archived: false, archivedReason: null }));
}

export type BranchLocalArchiveUnit = {
  root: Session;
  sessions: Session[];
  targets: SessionArchiveTarget[];
};

export type BranchLocalArchivePlan = {
  roots: Session[];
  additionalDescendants: Session[];
  withChildrenSessions: Session[];
  units: BranchLocalArchiveUnit[];
};

/** Build deterministic, non-overlapping permission/write units for bulk archive. */
export function planBranchLocalArchiveRoots(input: {
  roots: Session[];
  descendantsByRoot: Map<string, Session[]>;
  includeChildren: boolean;
}): BranchLocalArchivePlan {
  const roots = input.roots.filter((session) => !session.archived);
  const rootIds = new Set(roots.map((session) => session.session_id));
  const additionalById = new Map<string, Session>();

  for (const root of roots) {
    for (const descendant of input.descendantsByRoot.get(root.session_id) ?? []) {
      if (!descendant.archived && !rootIds.has(descendant.session_id)) {
        additionalById.set(descendant.session_id, descendant);
      }
    }
  }

  const nestedRootIds = new Set<string>();
  if (input.includeChildren) {
    for (const root of roots) {
      for (const descendant of input.descendantsByRoot.get(root.session_id) ?? []) {
        if (rootIds.has(descendant.session_id)) nestedRootIds.add(descendant.session_id);
      }
    }
  }

  const unitRoots = input.includeChildren
    ? roots.filter((root) => !nestedRootIds.has(root.session_id))
    : roots;
  const units = unitRoots.map((root): BranchLocalArchiveUnit => {
    const sessions = input.includeChildren
      ? [root, ...(input.descendantsByRoot.get(root.session_id) ?? [])].filter(
          (session) => !session.archived
        )
      : [root];
    return {
      root,
      sessions,
      targets: sessions.map((session) => ({
        session,
        archived: true,
        archivedReason: rootIds.has(session.session_id)
          ? MANUAL_ARCHIVED_REASON
          : PARENT_ARCHIVED_REASON,
      })),
    };
  });

  const withChildrenById = new Map<string, Session>(roots.map((root) => [root.session_id, root]));
  for (const descendant of additionalById.values()) {
    withChildrenById.set(descendant.session_id, descendant);
  }

  return {
    roots,
    additionalDescendants: [...additionalById.values()],
    withChildrenSessions: [...withChildrenById.values()],
    units,
  };
}
