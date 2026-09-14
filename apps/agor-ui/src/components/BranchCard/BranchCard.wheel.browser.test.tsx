import type { Branch, Repo, Session } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import ReactFlow, { Controls, type NodeProps, type ReactFlowInstance } from 'reactflow';
import 'reactflow/dist/style.css';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { REACT_FLOW_DRAG_HANDLE_SELECTOR } from '../../utils/reactFlowDragClasses';
import BranchCard from './BranchCard';

const branch = {
  branch_id: 'branch-1',
  name: 'Wheel routing',
  repo_id: 'repo-1',
  filesystem_status: 'ready',
  archived: false,
} as Branch;
const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;
const onSessionClick = vi.fn();

function CardNode({
  data,
}: NodeProps<{ sessions: Session[]; panelMode?: boolean; inPopover?: boolean; notes?: string }>) {
  return (
    <BranchCard
      branch={{ ...branch, notes: data.notes }}
      repo={repo}
      sessions={data.sessions}
      userById={new Map()}
      client={null}
      onSessionClick={onSessionClick}
      panelMode={data.panelMode}
      inPopover={data.inPopover}
    />
  );
}
const nodeTypes = { branch: CardNode };

async function mount(count: number, scheduled = false, notes?: string) {
  let flow: ReactFlowInstance | undefined;
  const sessions = Array.from(
    { length: count },
    (_, index) =>
      ({
        session_id: `session-${index}` as Session['session_id'],
        branch_id: branch.branch_id,
        title: `Conversation ${index}`,
        agentic_tool: 'codex',
        status: 'idle',
        archived: false,
        created_at: '2026-09-01T00:00:00.000Z',
        last_updated: new Date(Date.UTC(2026, 8, 1) - index * 1000).toISOString(),
        genealogy: { children: [] },
        created_by: 'user-1',
        unix_username: null,
        sdk_home_scope: 'branch',
        url: null,
        contextFiles: [],
        tasks: [],
        scheduled_from_branch: scheduled,
        scheduled_run_at: 1000 - index,
        ready_for_prompt: true,
      }) satisfies Session
  );
  const onNodeDragStop = vi.fn();
  const view = render(
    <App>
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 0,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <button type="button">Outside canvas</button>
        <div style={{ width: 900, height: 700 }}>
          <ReactFlow
            defaultNodes={[
              {
                id: 'branch',
                type: 'branch',
                position: { x: 70, y: 70 },
                dragHandle: REACT_FLOW_DRAG_HANDLE_SELECTOR,
                data: { sessions, notes },
              },
            ]}
            nodeTypes={nodeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: 0.7 }}
            minZoom={0.1}
            maxZoom={1.5}
            panOnScroll
            panOnDrag
            selectionOnDrag={false}
            nodesConnectable={false}
            zoomActivationKeyCode={['Meta', 'Control']}
            panActivationKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            disableKeyboardA11y
            onNodeDragStop={onNodeDragStop}
            onInit={(instance) => {
              flow = instance;
            }}
          >
            <Controls />
          </ReactFlow>
        </div>
      </ConnectionProvider>
    </App>
  );
  await screen.findByRole('button', { name: 'Open session Conversation 0' });
  await waitFor(() => expect(flow).toBeDefined());
  const scroller = scheduled
    ? (screen.getByRole('button', { name: 'Open session Conversation 0' }).closest('.nowheel')!
        .firstElementChild as HTMLElement)
    : view.container.querySelector<HTMLElement>('.ant-tree-list-holder')!;
  return { ...view, flow: flow!, scroller, onNodeDragStop };
}

beforeEach(() => {
  localStorage.clear();
  onSessionClick.mockClear();
});
afterEach(cleanup);

// A cancelable DOM event proves routing/cancellation, not browser UI zoom itself.
// In particular ctrlKey without keydown models the wheel form of trackpad pinch.
function wheel(target: Element, options: WheelEventInit = {}) {
  const box = target.getBoundingClientRect();
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
    deltaY: -50,
    ...options,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
}

it.each([2, 100])(
  'routes pinch on a %s-session tree to canvas zoom without scrolling the tree',
  async (count) => {
    const { flow, scroller, container } = await mount(count);
    const targets = {
      canvas: container.querySelector('.react-flow__pane')!,
      header: screen.getByText('Wheel routing'),
      control: screen.getByRole('button', { name: 'zoom in' }),
      row: screen.getByRole('button', { name: 'Open session Conversation 0' }),
      scroller,
    };
    for (const [location, target] of Object.entries(targets)) {
      await act(async () => flow.setViewport({ x: 0, y: 0, zoom: 0.7 }));
      await settle();
      const before = flow.getViewport();
      const scrollTop = scroller.scrollTop;
      const event = wheel(target, { ctrlKey: true });
      console.info('pinch routing', {
        count,
        location,
        canceled: event.defaultPrevented,
        before,
        after: flow.getViewport(),
        scrollTop: scroller.scrollTop,
      });
      // React Flow controls are a sibling of the renderer, not a canvas wheel
      // target. This patch deliberately does not add suppression there.
      expect(event.defaultPrevented, location).toBe(location !== 'control');
      if (location === 'control') expect(flow.getZoom()).toBe(before.zoom);
      else expect(flow.getZoom(), location).toBeGreaterThan(before.zoom);
      await settle();
      expect(scroller.scrollTop, location).toBe(scrollTop);
    }
  }
);

it.each([2, 100])('pans the canvas over a %s-session tree without scrolling it', async (count) => {
  const { flow, scroller } = await mount(count);
  const before = flow.getViewport();
  await act(async () =>
    userEvent.wheel(screen.getByRole('button', { name: 'Open session Conversation 0' }), {
      delta: { y: 150 },
    })
  );
  await waitFor(() => expect(flow.getViewport().y).not.toBe(before.y));
  expect(flow.getZoom()).toBe(before.zoom);
  expect(scroller.scrollTop).toBe(0);
});

it('pans and zooms the canvas over scheduled lists while preserving pagination', async () => {
  const { flow, scroller } = await mount(100, true);
  const before = flow.getViewport();
  await act(async () => userEvent.wheel(scroller, { delta: { y: 150 } }));
  await waitFor(() => expect(flow.getViewport().y).not.toBe(before.y));
  expect(flow.getZoom()).toBe(before.zoom);
  expect(scroller.scrollTop).toBe(0);
  const scrollTop = scroller.scrollTop;
  expect(wheel(scroller, { ctrlKey: true }).defaultPrevented).toBe(true);
  await settle();
  expect(scroller.scrollTop).toBe(scrollTop);
  expect(flow.getZoom()).toBeGreaterThan(before.zoom);
  const nextPage = screen.getByTitle('Next Page');
  expect(wheel(nextPage, { ctrlKey: true }).defaultPrevented).toBe(true);
  await act(async () => userEvent.click(nextPage));
  await act(async () =>
    userEvent.click(screen.getByRole('button', { name: 'Open session Conversation 20' }))
  );
  expect(onSessionClick).toHaveBeenCalledWith('session-20');
});

it.each([6, 40])(
  'scrolls a %s-paragraph description only when expanded and overflowing',
  async (count) => {
    const notes = Array.from(
      { length: count },
      (_, index) => `Description paragraph ${index}.`
    ).join('\n\n');
    const { flow } = await mount(2, false, notes);
    const more = await screen.findByRole('button', { name: 'See more' });
    const viewport = document.getElementById(more.getAttribute('aria-controls')!)!;
    const initialViewport = flow.getViewport();
    wheel(viewport, { deltaY: 30 });
    expect(flow.getViewport().y).not.toBe(initialViewport.y);
    expect(viewport.scrollTop).toBe(0);
    await act(async () => flow.setViewport(initialViewport));
    await act(async () => userEvent.click(more));
    await settle();
    expect(viewport.scrollHeight > viewport.clientHeight).toBe(count === 40);
    const beforeScroll = flow.getViewport();
    await act(async () => userEvent.wheel(viewport, { delta: { y: 60 } }));
    await settle();
    if (count === 40) {
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(flow.getViewport()).toEqual(beforeScroll);
    } else {
      expect(viewport.scrollTop).toBe(0);
      expect(flow.getViewport().y).not.toBe(beforeScroll.y);
    }
    const scrollTop = viewport.scrollTop;
    const zoom = flow.getZoom();
    expect(wheel(viewport, { ctrlKey: true }).defaultPrevented).toBe(true);
    await settle();
    expect(flow.getZoom()).toBeGreaterThan(zoom);
    expect(viewport.scrollTop).toBe(scrollTop);
  }
);

it.each(['Control', 'Meta'])(
  'cancels trusted %s+wheel and changes the rendered canvas transform, not inner scroll',
  async (modifier) => {
    const { flow, scroller, container } = await mount(100);
    // Start in the middle: rc-virtual-list would otherwise consume modified
    // wheel as scrolling even when it happens to prevent the browser default.
    await act(async () => {
      scroller.scrollTop = 150;
      fireEvent.scroll(scroller);
    });
    await settle();
    const before = flow.getViewport();
    const transform =
      container.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform;
    const events: WheelEvent[] = [];
    const observe = (event: WheelEvent) => {
      if (event.isTrusted) events.push(event);
    };
    document.addEventListener('wheel', observe, { capture: true, passive: true });
    try {
      await act(async () => userEvent.keyboard(`{${modifier}>}`));
      await settle();
      await act(async () => userEvent.wheel(scroller, { delta: { y: -50 } }));
      await waitFor(() => expect(flow.getZoom()).toBeGreaterThan(before.zoom));
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.defaultPrevented)).toBe(true);
      expect(events[0][modifier === 'Control' ? 'ctrlKey' : 'metaKey']).toBe(true);
      expect(
        container.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform
      ).not.toBe(transform);
      expect(scroller.scrollTop).toBe(150);
    } finally {
      document.removeEventListener('wheel', observe, { capture: true });
      await act(async () => userEvent.keyboard(`{/${modifier}}`));
    }
  }
);

it('keeps pinch at both scroll edges and canvas zoom limits from escaping to browser zoom', async () => {
  const { flow, scroller } = await mount(100);
  for (const [zoom, scrollTop, deltaY] of [
    [1.5, 0, -50],
    [0.1, scroller.scrollHeight, 50],
  ]) {
    await act(async () => {
      flow.setViewport({ x: 0, y: 0, zoom });
      scroller.scrollTop = scrollTop;
      fireEvent.scroll(scroller);
    });
    await settle();
    const top = scroller.scrollTop;
    expect(wheel(scroller, { ctrlKey: true, deltaY }).defaultPrevented).toBe(true);
    await settle();
    expect(flow.getZoom()).toBe(zoom);
    expect(scroller.scrollTop).toBe(top);
    // No modifier: pan the canvas even at a tree scroll edge.
    const beforePan = flow.getViewport();
    wheel(scroller, { deltaY });
    await settle();
    expect(flow.getViewport().y).not.toBe(beforePan.y);
    expect(scroller.scrollTop).toBe(top);
    expect(flow.getZoom()).toBe(zoom);
  }
});

it('preserves plain canvas panning, row clicks/keyboard activation, header drag and zoom controls', async () => {
  const { flow, container, onNodeDragStop } = await mount(2);
  const pane = container.querySelector('.react-flow__pane')!;
  const row = screen.getByRole('button', { name: 'Open session Conversation 0' });
  const before = flow.getViewport();
  expect(wheel(pane, { deltaY: 50 }).defaultPrevented).toBe(true);
  expect(flow.getViewport().y).not.toBe(before.y);
  expect(flow.getZoom()).toBe(before.zoom);
  await act(async () => userEvent.click(row));
  await act(async () => userEvent.keyboard('{Enter}'));
  expect(onSessionClick).toHaveBeenCalledTimes(2);
  expect(onSessionClick).toHaveBeenLastCalledWith('session-0');
  await act(async () =>
    userEvent.dragAndDrop(row, screen.getByRole('button', { name: 'Outside canvas' }))
  );
  expect(onNodeDragStop).not.toHaveBeenCalled();
  await act(async () =>
    userEvent.dragAndDrop(
      screen.getByText('Wheel routing'),
      screen.getByRole('button', { name: 'Outside canvas' })
    )
  );
  expect(onNodeDragStop).toHaveBeenCalledTimes(1);
  const zoom = flow.getZoom();
  await act(async () => userEvent.click(screen.getByRole('button', { name: 'zoom in' })));
  await waitFor(() => expect(flow.getZoom()).toBeGreaterThan(zoom));
});

it('leaves outside-canvas wheel and browser keyboard zoom shortcuts uncanceled', async () => {
  const { flow } = await mount(2);
  const outside = screen.getByRole('button', { name: 'Outside canvas' });
  const before = flow.getViewport();
  for (const modifiers of [{}, { shiftKey: true }, { altKey: true }]) {
    expect(
      wheel(screen.getByRole('button', { name: 'Open session Conversation 0' }), modifiers)
        .defaultPrevented
    ).toBe(true);
  }
  expect(flow.getZoom()).toBe(before.zoom);
  const afterPan = flow.getViewport();
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    expect(wheel(outside, modifiers).defaultPrevented).toBe(false);
    for (const key of ['+', '-', '0']) {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key,
        ...modifiers,
      });
      act(() => {
        outside.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
  }
  expect(flow.getViewport()).toEqual(afterPan);
});

it('opts panel/popover cards out, cleans up mode changes, and leaves standalone cards alone', async () => {
  const { flow, rerender, unmount } = await mount(2);
  const sessions: Session[] = flow.getNodes()[0].data.sessions;
  for (const mode of [
    { panelMode: true, inPopover: false },
    { panelMode: false, inPopover: true },
    { panelMode: false, inPopover: false },
  ]) {
    act(() =>
      flow.setNodes((nodes) => nodes.map((node) => ({ ...node, data: { ...node.data, ...mode } })))
    );
    await settle();
    const row = screen.getByRole('button', { name: 'Open session Conversation 0' });
    expect(wheel(row, { ctrlKey: true }).defaultPrevented).toBe(!mode.panelMode && !mode.inPopover);
  }
  rerender(
    <App>
      <BranchCard
        branch={branch}
        repo={repo}
        sessions={sessions}
        userById={new Map()}
        client={null}
      />
    </App>
  );
  const row = await screen.findByRole('button', { name: 'Open session Conversation 0' });
  expect(wheel(row, { ctrlKey: true }).defaultPrevented).toBe(false);
  unmount();
  expect(wheel(row, { ctrlKey: true }).defaultPrevented).toBe(false);
});

it('retains pointer anchoring and line-mode deltas when forwarding pinch', async () => {
  const { flow, container } = await mount(2);
  const row = screen.getByRole('button', { name: 'Open session Conversation 0' });
  const rect = row.getBoundingClientRect();
  // Chromium's constructed WheelEvent uses integer client coordinates.
  const pointer = {
    x: Math.trunc(rect.x + rect.width / 2),
    y: Math.trunc(rect.y + rect.height / 2),
  };
  const before = flow.screenToFlowPosition(pointer);
  const initialViewport = flow.getViewport();
  const gesture = {
    ctrlKey: true,
    deltaMode: WheelEvent.DOM_DELTA_LINE,
    deltaY: -1,
    clientX: pointer.x,
    clientY: pointer.y,
  };
  // Compare with React Flow itself rather than duplicate its platform-specific scaling.
  expect(wheel(container.querySelector('.react-flow__pane')!, gesture).defaultPrevented).toBe(true);
  const canvasViewport = flow.getViewport();
  expect(canvasViewport.zoom).toBeGreaterThan(initialViewport.zoom);
  await settle();
  await act(async () => flow.setViewport(initialViewport));
  await settle();
  expect(wheel(row, gesture).defaultPrevented).toBe(true);
  expect(flow.getViewport()).toEqual(canvasViewport);
  const after = flow.screenToFlowPosition(pointer);
  expect(after.x).toBeCloseTo(before.x);
  expect(after.y).toBeCloseTo(before.y);
});
