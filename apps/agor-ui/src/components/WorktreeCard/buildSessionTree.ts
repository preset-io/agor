/**
 * Build genealogy tree structure from flat sessions list
 *
 * Organizes sessions into a tree based on parent/fork relationships
 * Returns Ant Design Tree DataNode format
 */

import type { Session } from '@agor/core/types';
import type { DataNode } from 'antd/es/tree';

export type SessionRelationshipType = 'root' | 'spawn' | 'fork';

export interface SessionTreeNode extends DataNode {
  key: string;
  session: Session;
  relationshipType: SessionRelationshipType;
  children?: SessionTreeNode[];
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

  // Organize by parent/fork relationships
  for (const session of sessions) {
    const parentId =
      session.genealogy?.parent_session_id || session.genealogy?.forked_from_session_id;

    if (parentId) {
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
    if (!isRoot) {
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
