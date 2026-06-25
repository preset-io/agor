import type { Artifact, Board, BoardEntityObject, Branch, Repo, Session } from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { sessionPatched } from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import SessionCanvas from '../SessionCanvas/SessionCanvas';

// ── Render counters ──────────────────────────────────────────────────────────
// The BranchCard mock counts renders per branch and records the `sessions` prop
// it last received. This isolates the boundary the peel protects: each branch
// card now sources its session list from the store via a per-branch selector
// (read inside SessionCanvas's private `BranchNode` wrapper), so a
// `session:patched` for one branch must not re-render the other branch's card.
const branchCardRenders = new Map<string, number>();
const branchCardSessions = new Map<string, Session[]>();

vi.mock('../SessionCard', () => ({ __esModule: true, default: () => null }));
vi.mock('../CardNode', () => ({
  __esModule: true,
  default: () => <div data-testid="card-node" />,
}));

vi.mock('../BranchCard', () => ({
  __esModule: true,
  default: ({ branch, sessions }: { branch: Branch; sessions: Session[] }) => {
    branchCardRenders.set(branch.branch_id, (branchCardRenders.get(branch.branch_id) ?? 0) + 1);
    branchCardSessions.set(branch.branch_id, sessions);
    return <div data-testid={`branch-card-${branch.branch_id}`} />;
  },
}));

// Render real node components through `nodeTypes` so the in-component React.memo
// boundary (BranchNode's custom areEqual + its per-branch store subscription) is
// exercised. We pass ONLY `data` (mirroring how React Flow re-renders a node
// component) so the assertions reflect the store subscription, not node-object
// churn from the sync effects.
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
    }) => (
      <div data-testid="react-flow">
        {props.nodes?.map((node) => {
          const NodeComponent = props.nodeTypes?.[node.type];
          return NodeComponent ? <NodeComponent key={node.id} data={node.data} /> : null;
        })}
        {props.children}
      </div>
    ),
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
];

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
    boardObjectsByBoardId: new Map([[BOARD_ID, boardObjects]]),
  });
}

describe('BranchCard store-selector session isolation', () => {
  beforeEach(() => {
    branchCardRenders.clear();
    branchCardSessions.clear();
    agorStore.setState({ ...EMPTY_MAPS });
    seedStore();
  });

  it('a session:patched for branch A re-renders only branch A’s card with the updated session', async () => {
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

    await waitFor(() => {
      expect(branchCardRenders.get('A')).toBeGreaterThanOrEqual(1);
      expect(branchCardRenders.get('B')).toBeGreaterThanOrEqual(1);
    });

    const branchABaseline = branchCardRenders.get('A') ?? 0;
    const branchBBaseline = branchCardRenders.get('B') ?? 0;
    const branchBSessionsBaseline = branchCardSessions.get('B');

    // Patch session A only. `sessionPatched` rebuilds branch A's session bucket
    // while leaving branch B's array reference untouched.
    act(() => {
      sessionPatched(makeSession('sA', 'A', 'completed'));
    });

    await waitFor(() => {
      expect(branchCardRenders.get('A') ?? 0).toBeGreaterThan(branchABaseline);
    });

    // Branch A's card sourced the patched session from the store…
    expect(branchCardSessions.get('A')?.[0]?.status).toBe('completed');
    // …and branch B's card — whose per-branch session selector kept the same
    // array reference across the patch — neither re-rendered nor saw its
    // `sessions` prop change. This is the win the peel locks in: it FAILS if
    // BranchNode subscribes to the whole `sessionsByBranch` map (every patch
    // re-renders every card) or if its `areEqual` is removed.
    expect(branchCardRenders.get('B') ?? 0).toBe(branchBBaseline);
    expect(branchCardSessions.get('B')).toBe(branchBSessionsBaseline);
  });

  it('a patch to a slice no branch card reads leaves every card un-rendered', async () => {
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

    await waitFor(() => {
      expect(branchCardRenders.get('A')).toBeGreaterThanOrEqual(1);
      expect(branchCardRenders.get('B')).toBeGreaterThanOrEqual(1);
    });

    const branchABaseline = branchCardRenders.get('A') ?? 0;
    const branchBBaseline = branchCardRenders.get('B') ?? 0;

    act(() => {
      agorStore.setState({
        artifactById: new Map<string, Artifact>([
          ['artifact-1', { artifact_id: 'artifact-1' } as unknown as Artifact],
        ]),
      });
    });

    expect(branchCardRenders.get('A') ?? 0).toBe(branchABaseline);
    expect(branchCardRenders.get('B') ?? 0).toBe(branchBBaseline);
  });
});
