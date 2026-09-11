import type { Node } from 'reactflow';
import { describe, expect, it } from 'vitest';
import {
  getMeasuredLayoutNodeSize,
  getVisibleSelectableNodeRect,
  isVisibleSelectableBoardNode,
} from './boardNodeGeometry';

const entityTypes = ['branchNode', 'cardNode', 'zone', 'markdown', 'appNode', 'artifactNode'];

function node(type: string, overrides: Partial<Node> = {}): Node {
  return {
    id: type,
    type,
    position: { x: 10, y: 20 },
    width: 100,
    height: 50,
    data: {},
    ...overrides,
  };
}

describe('board node geometry eligibility', () => {
  it('admits every current movable board entity family without type special-casing', () => {
    expect(entityTypes.map((type) => isVisibleSelectableBoardNode(node(type)))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(isVisibleSelectableBoardNode(node('futureCanvasObject'))).toBe(true);
  });

  it.each([
    ['hidden', { hidden: true }],
    ['non-selectable', { selectable: false }],
    ['non-draggable', { draggable: false }],
    ['locked', { data: { locked: true } }],
  ])('excludes %s nodes', (_label, overrides) => {
    expect(isVisibleSelectableBoardNode(node('artifactNode', overrides))).toBe(false);
  });

  it('uses rendered dimensions and absolute nested coordinates', () => {
    const parent = node('zone', { id: 'zone', position: { x: 100, y: 200 } });
    const child = node('branchNode', {
      id: 'branch',
      parentId: 'zone',
      position: { x: 25, y: 35 },
      width: undefined,
      height: undefined,
      style: { width: 220, height: 90 },
    });
    expect(getVisibleSelectableNodeRect(child, [parent, child])).toEqual({
      x: 125,
      y: 235,
      width: 220,
      height: 90,
    });
  });

  it('rejects zero-area rendered nodes', () => {
    expect(getVisibleSelectableNodeRect(node('markdown', { width: 0 }), [])).toBeNull();
  });

  it('prefers the actual production node box to stale stored dimensions', () => {
    const element = document.createElement('div');
    element.className = 'react-flow__node';
    element.dataset.id = 'branch';
    Object.defineProperties(element, {
      offsetWidth: { value: 380 },
      offsetHeight: { value: 236 },
      scrollWidth: { value: 400 },
      scrollHeight: { value: 236 },
    });
    document.body.append(element);

    expect(
      getMeasuredLayoutNodeSize(node('branchNode', { id: 'branch', width: 300, height: 120 }))
    ).toEqual({ width: 400, height: 236 });
    element.remove();
  });
});
