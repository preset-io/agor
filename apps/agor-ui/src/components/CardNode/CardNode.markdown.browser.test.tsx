import type { BoardID, CardID, CardWithType } from '@agor/core/types';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReactFlow from 'reactflow';
import 'reactflow/dist/style.css';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import {
  REACT_FLOW_DRAG_HANDLE_SELECTOR,
  REACT_FLOW_NO_WHEEL_CLASS,
} from '../../utils/reactFlowDragClasses';
import CardNode, { type CardNodeData } from './CardNode';

const description = Array.from(
  { length: 30 },
  (_, i) => `Paragraph ${i}: a line of description.`
).join('\n\n');
const card: CardWithType = {
  card_id: 'card-1' as CardID,
  board_id: 'board-1' as BoardID,
  title: 'Planning card',
  description,
  archived: false,
  created_at: '2026-09-06T00:00:00.000Z',
  updated_at: '2026-09-06T00:00:00.000Z',
};
const nodeTypes = { cardNode: CardNode };

afterEach(cleanup);

it('isolates Markdown links and disclosures while preserving ordinary open-card clicks', () => {
  const onClick = vi.fn();
  render(
    <CardNode
      data={{
        card: {
          ...card,
          description:
            '[Link](https://example.com)\n\n<details><summary>Details</summary>Body</details>\n\nPlain text',
        },
        onClick,
      }}
    />
  );
  const link = screen.getByRole('link', { name: 'Link' });
  link.addEventListener('click', (event) => event.preventDefault());
  fireEvent.click(link);
  fireEvent.click(screen.getByText('Details'));
  expect(onClick).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Plain text'));
  expect(onClick).toHaveBeenCalledWith(card.card_id);
});

it('resets expansion after clearing content or switching card identity', () => {
  const { rerender } = render(<CardNode data={{ card }} />);
  fireEvent.click(screen.getByRole('button', { name: 'more' }));
  rerender(<CardNode data={{ card: { ...card, description: '' } }} />);
  rerender(<CardNode data={{ card }} />);
  expect(screen.getByRole('button', { name: 'more' })).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'more' }));
  rerender(<CardNode data={{ card: { ...card, card_id: 'card-2' as CardID } }} />);
  expect(screen.getByRole('button', { name: 'more' })).toHaveAttribute('aria-expanded', 'false');
});

it('keeps executable markup and javascript links inert in descriptions', () => {
  const { container } = render(
    <CardNode
      data={{
        card: {
          ...card,
          description:
            '<script>window.__xss=1</script>\n\n[x](javascript:alert(1))\n\n<img src="x" onerror="window.__xss=1">',
        },
      }}
    />
  );
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('[onerror]')).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
});

it('keeps native wheel scrolling inside the expanded preview and dragging on the header', async () => {
  const onNodeDragStop = vi.fn();
  const { container } = render(
    <>
      <div style={{ width: '100%', height: 380 }}>
        <ReactFlow
          nodes={[
            {
              id: 'card',
              type: 'cardNode',
              position: { x: 0, y: 0 },
              width: 380,
              height: 120,
              dragHandle: REACT_FLOW_DRAG_HANDLE_SELECTOR,
              data: { card } satisfies CardNodeData,
            },
          ]}
          nodeTypes={nodeTypes}
          panOnScroll
          panOnDrag
          nodesConnectable={false}
          disableKeyboardA11y
          onNodeDragStop={onNodeDragStop}
        />
      </div>
      <div
        data-testid="drop-target"
        style={{ position: 'fixed', left: 240, top: 350, width: 30, height: 20 }}
      >
        Drop
      </div>
    </>
  );
  const more = await screen.findByRole('button', { name: 'more' });
  fireEvent.click(more);
  const viewport = document.getElementById(more.getAttribute('aria-controls')!)!;
  const canvas = container.querySelector('.react-flow__viewport') as HTMLElement;
  const transform = canvas.style.transform;
  expect(viewport).toHaveClass(REACT_FLOW_NO_WHEEL_CLASS);
  await act(async () => userEvent.wheel(viewport, { delta: { y: 150 } }));
  await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
  expect(canvas.style.transform).toBe(transform);
  fireEvent.click(screen.getByRole('button', { name: 'less' }));
  expect(viewport).not.toHaveClass(REACT_FLOW_NO_WHEEL_CLASS);
  expect(viewport.scrollTop).toBe(0);
  await act(async () =>
    userEvent.dragAndDrop(
      screen.getByText('Paragraph 0: a line of description.'),
      screen.getByTestId('drop-target')
    )
  );
  expect(onNodeDragStop).not.toHaveBeenCalled();
  await act(async () =>
    userEvent.dragAndDrop(screen.getByText('Planning card'), screen.getByTestId('drop-target'))
  );
  expect(onNodeDragStop).toHaveBeenCalledTimes(1);
});
