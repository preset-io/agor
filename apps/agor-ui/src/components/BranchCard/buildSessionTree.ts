/**
 * Build genealogy tree structure from flat sessions list
 *
 * Organizes sessions into a tree based on parent/fork relationships
 * Returns Ant Design Tree DataNode format
 */

import type { Session } from '@agor-live/client';
import type { DataNode } from 'antd/es/tree';

export type SessionRelationshipType = 'root' | 'spawn' | 'fork' | 'remote';

export interface SessionTreeNode extends DataNode {
  key: string;
  session: Session;
  relationshipType: SessionRelationshipType;
  children?: SessionTreeNode[];
}

/** Return the single genealogy edge used to place a Session in the UI tree. */
export function getSessionTreeParentId(session: Session): string | undefined {
  return (
    session.genealogy?.parent_session_id || session.genealogy?.forked_from_session_id || undefined
  );
}

/**
 * Collect roots and every descendant reachable through the same genealogy
 * edges as buildSessionTree. Keeping this alongside tree construction avoids
 * section partitioning drifting from the rendered hierarchy.
 */
export function collectSessionSubtreeIds(
  sessions: Session[],
  rootSessionIds: Iterable<string>
): Set<string> {
  const included = new Set(rootSessionIds);
  const childrenByParent = new Map<string, string[]>();

  for (const session of sessions) {
    const parentId = getSessionTreeParentId(session);
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(session.session_id);
    childrenByParent.set(parentId, children);
  }

  const pending = [...included];
  for (let index = 0; index < pending.length; index += 1) {
    for (const childId of childrenByParent.get(pending[index]!) ?? []) {
      if (included.has(childId)) continue;
      included.add(childId);
      pending.push(childId);
    }
  }

  return included;
}

/**
 * Build genealogy tree from sessions for Ant Design Tree
 *
 * Returns array of root sessions (no parent/fork) with their full subtrees in DataNode format
 */
export function buildSessionTree(sessions: Session[]): SessionTreeNode[] {
  const sessionMap = new Map<string, Session>();
  const childrenMap = new Map<string, Session[]>();
  const roots: Session[] = [];

  // Build maps
  for (const session of sessions) {
    sessionMap.set(session.session_id, session);
  }

  // Organize by parent/fork relationships. The input list may already be
  // filtered (for example, archived sessions are removed before rendering in
  // BranchSessionSections), so only attach to a parent that is also present in
  // this render set. Otherwise promote the session to a root so the tree does
  // not silently hide visible sessions behind a filtered-out ancestor.
  for (const session of sessions) {
    const parentId = getSessionTreeParentId(session);

    if (parentId && sessionMap.has(parentId)) {
      // Has a parent - add to children map
      const siblings = childrenMap.get(parentId) || [];
      siblings.push(session);
      childrenMap.set(parentId, siblings);
    } else {
      // No parent - it's a root
      roots.push(session);
    }
  }

  // Build tree recursively
  function buildNode(session: Session, isRoot = false): SessionTreeNode {
    const children = childrenMap.get(session.session_id) || [];

    // Determine relationship type
    let relationshipType: SessionRelationshipType = 'root';
    if (session.remote_surrogate) {
      relationshipType = 'remote';
    } else if (!isRoot) {
      if (session.genealogy?.parent_session_id) {
        relationshipType = 'spawn';
      } else if (session.genealogy?.forked_from_session_id) {
        relationshipType = 'fork';
      }
    }

    const node: SessionTreeNode = {
      key: session.session_id,
      title: '', // Empty string to prevent default tooltip (titleRender handles display)
      session,
      relationshipType,
    };

    if (children.length > 0) {
      node.children = children.map((child) => buildNode(child, false));
    }

    return node;
  }

  // Build trees for each root
  return roots.map((root) => buildNode(root, true));
}
