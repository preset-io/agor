import type { Session } from '@agor-live/client';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { BranchSessionTree } from './BranchSessionTree';
import type { SessionTreeNode } from './buildSessionTree';

afterEach(cleanup);

const node = (key: string): SessionTreeNode => ({
  key,
  session: { session_id: key } as Session,
  relationshipType: 'root',
  isLeaf: true,
});

it('does not shade another row when a row button takes keyboard focus', async () => {
  render(
    <BranchSessionTree
      fillAvailableHeight={false}
      selectable={false}
      treeData={[node('first'), node('second')]}
      titleRender={(item) => <button type="button">{item.key}</button>}
    />
  );

  await userEvent.keyboard('{Shift}');
  act(() => screen.getByRole('button', { name: 'second' }).focus());

  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(document.querySelector('.ant-tree-treenode-active')).toBeNull();
});
