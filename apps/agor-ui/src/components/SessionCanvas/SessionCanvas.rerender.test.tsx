import type {
  Artifact,
  Board,
  BoardEntityObject,
  Branch,
  CardWithType,
  Repo,
  Session,
} from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { sessionPatched } from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import SessionCanvas from './SessionCanvas';

// ── Render counters ──────────────────────────────────────────────────────────
// Leaf node components are mocked to count renders per entity. This isolates the
// memo boundaries the store migration is meant to protect: a `session:patched`
// for one branch must not re-render the other branch's card, nor the
// board-object-derived card node.
const branchCardRenders = new Map<string, number>();
let cardNodeRenders = 0;
// SessionCanvas's own render count. The mocked ReactFlow below renders exactly
// once per SessionCanvas render, so its invocation count is a faithful proxy —
// it lets us assert the memo+selector boundary protects the WHOLE canvas, not
// just the leaf node components.
let sessionCanvasRenders = 0;

vi.mock('../BranchCard', () => ({
  __esModule: true,
  default: ({ branch }: { branch: Branch }) => {
    branchCardRenders.set(branch.branch_id, (branchCardRenders.get(branch.branch_id) ?? 0) + 1);
    return <div data-testid={`branch-card-${branch.branch_id}`} />;
  },
}));

vi.mock('../CardNode', () => ({
  __esModule: true,
  default: () => {
    cardNodeRenders += 1;
    return <div data-testid="card-node" />;
  },
}));

// Render real node components through `nodeTypes` so the in-component React.memo
// boundaries (BranchNode's custom areEqual, CardNodeWrapper's shallow compare)
// are exercised. We deliberately pass ONLY `data` (mirroring how React Flow
// re-renders a node component) so the assertions reflect data-reference
// stability rather than node-object churn from the sync effects.
vi.mock('reactflow', async () => {
  const React = await import('react');
  return {
    Background: () => null,
    Controls: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    ControlButton: ({ children }: { children?: React.ReactNode }) => (
      <button type="button">{children}</button>
    ),
    MiniMap: () => null,
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    useNodesState: (initial: unknown[]) => {
      const [nodes, setNodes] = React.useState(initial);
      const onNodesChange = React.useCallback(() => {}, []);
      return [nodes, setNodes, onNodesChange];
    },
    useEdgesState: (initial: unknown[]) => {
      const [edges, setEdges] = React.useState(initial);
      const onEdgesChange = React.useCallback(() => {}, []);
      return [edges, setEdges, onEdgesChange];
    },
    ReactFlow: (props: {
      nodes?: Array<{ id: string; type: string; data: unknown }>;
      nodeTypes?: Record<string, React.ComponentType<{ data: unknown }>>;
      children?: React.ReactNode;
    }) => {
      sessionCanvasRenders += 1;
      return (
        <div data-testid="react-flow">
          {props.nodes?.map((node) => {
            const NodeComponent = props.nodeTypes?.[node.type];
            return NodeComponent ? <NodeComponent key={node.id} data={node.data} /> : null;
          })}
          {props.children}
        </div>
      );
    },
  };
});

const BOARD_ID = 'board-1';
const REPO_ID = 'repo-1';

const board = {
  board_id: BOARD_ID,
  name: 'Board',
  slug: 'board',
  objects: {},
  created_at: '2026-06-24T00:00:00.000Z',
  last_updated: '2026-06-24T00:00:00.000Z',
  created_by: 'user-1',
  url: 'http://localhost/ui/b/board/',
  archived: false,
} as unknown as Board;

const repo = { repo_id: REPO_ID, name: 'repo', slug: 'repo' } as unknown as Repo;

const makeBranch = (id: string): Branch =>
  ({
    branch_id: id,
    repo_id: REPO_ID,
    board_id: BOARD_ID,
    name: id,
    archived: false,
    others_can: 'session',
  }) as unknown as Branch;

const makeSession = (id: string, branchId: string, status: string): Session =>
  ({
    session_id: id,
    branch_id: branchId,
    status,
    archived: false,
    created_at: '2026-06-24T00:00:00.000Z',
    last_updated: '2026-06-24T00:00:00.000Z',
  }) as unknown as Session;

const card = {
  card_id: 'card-1',
  board_id: BOARD_ID,
  title: 'Card',
  archived: false,
} as unknown as CardWithType;

const branchA = makeBranch('A');
const branchB = makeBranch('B');
const sessionA = makeSession('sA', 'A', 'running');
const sessionB = makeSession('sB', 'B', 'running');

const boardObjects: BoardEntityObject[] = [
  {
    object_id: 'bo-A',
    board_id: BOARD_ID,
    branch_id: 'A',
    entity_type: 'branch',
    position: { x: 0, y: 0 },
  } as unknown as BoardEntityObject,
  {
    object_id: 'bo-B',
    board_id: BOARD_ID,
    branch_id: 'B',
    entity_type: 'branch',
    position: { x: 0, y: 600 },
  } as unknown as BoardEntityObject,
  {
    object_id: 'bo-card',
    board_id: BOARD_ID,
    card_id: 'card-1',
    entity_type: 'card',
    position: { x: 800, y: 0 },
  } as unknown as BoardEntityObject,
];

// Stable references for the parent-re-render guard below. When a parent
// re-renders, React.memo only bails out if EVERY prop kept its identity, so
// these have to be module-level constants (a fresh inline array / context value
// per render would itself break memo and mask whether handler stabilization is
// what's protecting the canvas).
const BRANCHES: Branch[] = [branchA, branchB];
const CONNECTION_VALUE = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

function seedStore() {
  agorStore.setState({
    ...EMPTY_MAPS,
    repoById: new Map([[REPO_ID, repo]]),
    branchById: new Map([
      ['A', branchA],
      ['B', branchB],
    ]),
    sessionById: new Map([
      ['sA', sessionA],
      ['sB', sessionB],
    ]),
    sessionsByBranch: new Map([
      ['A', [sessionA]],
      ['B', [sessionB]],
    ]),
    cardById: new Map([['card-1', card]]),
    boardObjectsByBoardId: new Map([[BOARD_ID, boardObjects]]),
  });
}

describe('SessionCanvas store-selector re-render isolation', () => {
  beforeEach(() => {
    branchCardRenders.clear();
    cardNodeRenders = 0;
    sessionCanvasRenders = 0;
    agorStore.setState({ ...EMPTY_MAPS });
    seedStore();
  });

  it('a session:patched for branch A does not re-render branch B card nor the board-object card node', async () => {
    render(
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <SessionCanvas board={board} client={null} branches={[branchA, branchB]} />
      </ConnectionProvider>
    );

    // Wait until both branch cards and the card node have rendered from the
    // node-sync effects.
    await waitFor(() => {
      expect(branchCardRenders.get('A')).toBeGreaterThanOrEqual(1);
      expect(branchCardRenders.get('B')).toBeGreaterThanOrEqual(1);
      expect(cardNodeRenders).toBeGreaterThanOrEqual(1);
    });

    const canvasBaseline = sessionCanvasRenders;
    const branchBBaseline = branchCardRenders.get('B') ?? 0;
    const branchABaseline = branchCardRenders.get('A') ?? 0;
    const cardNodeBaseline = cardNodeRenders;

    // Patch session A only.
    act(() => {
      sessionPatched(makeSession('sA', 'A', 'completed'));
    });

    await waitFor(() => {
      expect(branchCardRenders.get('A') ?? 0).toBeGreaterThan(branchABaseline);
    });

    // The win: the session patch is handled inside the affected BranchNode's
    // per-branch subscription. SessionCanvas itself does not subscribe to the
    // whole sessionsByBranch map, so React Flow's controlled node array is not
    // rebuilt for every streaming session patch.
    expect(sessionCanvasRenders).toBe(canvasBaseline);
    expect(branchCardRenders.get('B') ?? 0).toBe(branchBBaseline);
    expect(cardNodeRenders).toBe(cardNodeBaseline);
  });

  it('a patch to a slice SessionCanvas does not select leaves the whole canvas un-rendered', async () => {
    render(
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <SessionCanvas board={board} client={null} branches={[branchA, branchB]} />
      </ConnectionProvider>
    );

    // Let the initial node-sync effects settle so the render count is stable.
    await waitFor(() => {
      expect(branchCardRenders.get('A')).toBeGreaterThanOrEqual(1);
      expect(branchCardRenders.get('B')).toBeGreaterThanOrEqual(1);
      expect(sessionCanvasRenders).toBeGreaterThanOrEqual(1);
    });

    const canvasBaseline = sessionCanvasRenders;
    const branchABaseline = branchCardRenders.get('A') ?? 0;
    const branchBBaseline = branchCardRenders.get('B') ?? 0;
    const cardNodeBaseline = cardNodeRenders;

    // Patch a slice SessionCanvas never subscribes to (artifacts). zustand
    // notifies every subscriber, but each of SessionCanvas's selector slices
    // keeps its reference, so its `useSyncExternalStore` subscriptions stay
    // quiet and the component does not re-render at all.
    act(() => {
      agorStore.setState({
        artifactById: new Map<string, Artifact>([
          ['artifact-1', { artifact_id: 'artifact-1' } as unknown as Artifact],
        ]),
      });
    });

    // The memo+selector boundary holds: SessionCanvas itself — not just the leaf
    // node memos — was insulated from the unrelated store change.
    expect(sessionCanvasRenders).toBe(canvasBaseline);
    expect(branchCardRenders.get('A') ?? 0).toBe(branchABaseline);
    expect(branchCardRenders.get('B') ?? 0).toBe(branchBBaseline);
    expect(cardNodeRenders).toBe(cardNodeBaseline);
  });
});

// Mirror of AppContent's `useStableCallback`: freeze a handler's identity across
// renders while delegating to the latest impl via a ref. This is the exact
// mechanism AppContent uses to keep SessionCanvas's action handlers stable, so
// reproducing it here exercises the real prop-stabilization contract.
function useStableCallback<TFn extends (...args: never[]) => unknown>(
  callback: TFn | undefined
): TFn | undefined {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  const stable = useCallback(((...args: never[]) => callbackRef.current?.(...args)) as TFn, []);
  return callback ? stable : undefined;
}

// Lets a test trigger a parent re-render without touching SessionCanvas's props.
let triggerParentRerender: () => void = () => {};

// Parent harness that renders the REAL memo'd SessionCanvas the way AppContent
// does: action handlers flow through `useStableCallback` so their identity is
// frozen. A `useState` bump (driven from the test) re-renders THIS parent; the
// `stabilize` flag toggles whether the fork handler is stabilized, so the same
// harness can prove both halves of the guard.
function ParentHarness({ stabilize }: { stabilize: boolean }) {
  const [, setTick] = useState(0);
  triggerParentRerender = () => setTick((tick) => tick + 1);

  // Fresh identity on every parent render (mirrors AppContent's plain-const
  // handlers). When `stabilize` is true we freeze it through useStableCallback;
  // when false we pass it straight through so memo sees a new prop each render.
  const forkImpl = (_sessionId: string, _prompt: string) => Promise.resolve();
  const stableForkSession = useStableCallback(forkImpl);
  const onForkSession = stabilize ? stableForkSession : forkImpl;

  return (
    <ConnectionProvider value={CONNECTION_VALUE}>
      <SessionCanvas
        board={board}
        client={null}
        branches={BRANCHES}
        onForkSession={onForkSession}
      />
    </ConnectionProvider>
  );
}

describe('SessionCanvas memo + handler-stabilization re-render bailout', () => {
  beforeEach(() => {
    branchCardRenders.clear();
    cardNodeRenders = 0;
    sessionCanvasRenders = 0;
    triggerParentRerender = () => {};
    agorStore.setState({ ...EMPTY_MAPS });
    seedStore();
  });

  it('a parent re-render does not re-render the memo’d SessionCanvas when handlers are stabilized', async () => {
    render(<ParentHarness stabilize={true} />);

    // Let the initial node-sync effects settle so the render count is stable.
    await waitFor(() => {
      expect(branchCardRenders.get('A')).toBeGreaterThanOrEqual(1);
      expect(branchCardRenders.get('B')).toBeGreaterThanOrEqual(1);
      expect(sessionCanvasRenders).toBeGreaterThanOrEqual(1);
    });

    const canvasBaseline = sessionCanvasRenders;
    const branchABaseline = branchCardRenders.get('A') ?? 0;
    const branchBBaseline = branchCardRenders.get('B') ?? 0;

    // Re-render the PARENT. Every SessionCanvas prop kept its identity (board,
    // branches, the stabilized fork handler), so React.memo bails out and the
    // canvas — plus its leaf cards — stays put.
    act(() => {
      triggerParentRerender();
    });

    // This is the regression guard: it FAILS if `React.memo(SessionCanvasInner)`
    // is removed (parent re-render always re-renders the canvas) OR if the fork
    // handler is destabilized (a fresh prop identity defeats the shallow memo).
    expect(sessionCanvasRenders).toBe(canvasBaseline);
    expect(branchCardRenders.get('A') ?? 0).toBe(branchABaseline);
    expect(branchCardRenders.get('B') ?? 0).toBe(branchBBaseline);
  });

  it('a parent re-render DOES re-render the canvas when a handler identity is not stabilized', async () => {
    // Contrast case: proves the guard above is meaningful. The same parent,
    // passing a fresh-identity fork handler each render, breaks the memo shallow
    // compare — so the bailout asserted above genuinely depends on stabilization.
    render(<ParentHarness stabilize={false} />);

    await waitFor(() => {
      expect(branchCardRenders.get('A')).toBeGreaterThanOrEqual(1);
      expect(branchCardRenders.get('B')).toBeGreaterThanOrEqual(1);
      expect(sessionCanvasRenders).toBeGreaterThanOrEqual(1);
    });

    const canvasBaseline = sessionCanvasRenders;

    act(() => {
      triggerParentRerender();
    });

    await waitFor(() => {
      expect(sessionCanvasRenders).toBeGreaterThan(canvasBaseline);
    });
  });
});
