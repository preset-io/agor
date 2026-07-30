import { beforeEach, describe, expect, it } from 'vitest';
import {
  COLLAPSED_BRANCH_NODES_STORAGE_KEY,
  readCollapsedBranchNode,
  removeCollapsedBranchNode,
  setCollapsedBranchNode,
} from './collapsedBranchNodes';

describe('collapsedBranchNodes', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe('setCollapsedBranchNode', () => {
    it('stores only branches with real exceptions', () => {
      const nodes = setCollapsedBranchNode({}, 'branch-1', {
        sections: ['sessions'],
        sessionIds: [],
      });

      expect(nodes).toEqual({ 'branch-1': { sections: ['sessions'] } });
    });

    it('drops the whole entry when the last exception is removed', () => {
      const nodes = setCollapsedBranchNode(
        { 'branch-1': { sections: ['sessions'] }, 'branch-2': { sessionIds: ['session-1'] } },
        'branch-1',
        { sections: [], sessionIds: [] }
      );

      expect(nodes).toEqual({ 'branch-2': { sessionIds: ['session-1'] } });
    });

    it('returns the same object when clearing a branch with no entry', () => {
      const nodes = { 'branch-2': { sessionIds: ['session-1'] } };

      expect(setCollapsedBranchNode(nodes, 'branch-1', {})).toBe(nodes);
    });
  });

  describe('removeCollapsedBranchNode', () => {
    it('redacts only the deleted branch entry', () => {
      window.localStorage.setItem(
        COLLAPSED_BRANCH_NODES_STORAGE_KEY,
        JSON.stringify({
          'branch-1': { sections: ['sessions'] },
          'branch-2': { sessionIds: ['session-1'] },
        })
      );

      removeCollapsedBranchNode('branch-1');

      expect(readCollapsedBranchNode('branch-1')).toEqual({});
      expect(readCollapsedBranchNode('branch-2')).toEqual({ sessionIds: ['session-1'] });
    });

    it('does not create a store entry for an unknown branch', () => {
      removeCollapsedBranchNode('branch-unknown');

      expect(window.localStorage.getItem(COLLAPSED_BRANCH_NODES_STORAGE_KEY)).toBeNull();
    });
  });
});
