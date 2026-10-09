import type { AgorClient, Board, BoardEntityObject, Branch, Repo } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CanvasNavigationProvider,
  useRegisterRecenter,
} from '../../contexts/CanvasNavigationContext';
import { BoardBranchList } from './BoardBranchList';

const board = {
  board_id: 'board-1',
  name: 'Board 1',
} as Board;

const repo = {
  repo_id: 'repo-1',
  slug: 'preset-io/agor',
} as Repo;

const shownBranch = {
  branch_id: 'branch-shown',
  board_id: 'board-1',
  repo_id: 'repo-1',
  name: 'feature/visible',
  archived: false,
  last_used: '2026-05-31T00:00:00.000Z',
  zone_label: 'In Review',
} as unknown as Branch;

const hiddenBranch = {
  branch_id: 'branch-hidden',
  board_id: 'board-1',
  repo_id: 'repo-1',
  name: 'feature/archived',
  archived: true,
  last_used: '2026-05-30T00:00:00.000Z',
} as unknown as Branch;

const makeClient = (branches: Branch[]): AgorClient => {
  const service = {
    findAll: vi.fn().mockResolvedValue(branches),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return { service: vi.fn().mockReturnValue(service) } as unknown as AgorClient;
};

/**
 * Client mock with a working event registry so tests can drive realtime
 * refetches. Each service name gets its own handler map; `emit` invokes every
 * handler registered for a given service+event.
 */
const makeEmittingClient = (branches: () => Branch[]) => {
  const handlers = new Map<string, Map<string, Set<(payload: unknown) => void>>>();
  const findAll = vi.fn().mockImplementation(() => Promise.resolve(branches()));

  const serviceFor = (name: string) => {
    const events = handlers.get(name) ?? new Map();
    handlers.set(name, events);
    return {
      findAll,
      on: (event: string, handler: (payload: unknown) => void) => {
        const set = events.get(event) ?? new Set();
        set.add(handler);
        events.set(event, set);
      },
      removeListener: (event: string, handler: (payload: unknown) => void) => {
        events.get(event)?.delete(handler);
      },
    };
  };

  const client = { service: vi.fn().mockImplementation(serviceFor) } as unknown as AgorClient;

  const emit = (name: string, event: string, payload: unknown) => {
    for (const handler of handlers.get(name)?.get(event) ?? []) handler(payload);
  };

  return { client, emit, findAll };
};

const renderList = (
  client: AgorClient | null,
  registerRecenter: (nodeId: string) => boolean = () => false
) => {
  const Harness: React.FC = () => {
    // Register a fake canvas recenter so we can assert pan-to calls.
    useRegisterRecenter(registerRecenter);
    return (
      <BoardBranchList board={board} repoById={new Map([[repo.repo_id, repo]])} client={client} />
    );
  };

  return render(
    <CanvasNavigationProvider>
      <Harness />
    </CanvasNavigationProvider>
  );
};

describe('BoardBranchList', () => {
  it('lists both shown and hidden (archived) branches with their zone label', async () => {
    renderList(makeClient([shownBranch, hiddenBranch]));

    expect(await screen.findByText('feature/visible')).toBeInTheDocument();
    // Hidden/archived branch is included (no visibility filtering).
    expect(screen.getByText('feature/archived')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    // Zone pinning label from the enriched branch list API is surfaced.
    expect(screen.getByText('In Review')).toBeInTheDocument();
  });

  it.each([
    [{ filesystem_status: 'failed' }, 'Setup failed'],
    [{ filesystem_status: 'cleaned' }, 'Files removed'],
    [{ deletion_status: 'deleting' }, 'Deleting'],
    [{ deletion_status: 'deletion_failed' }, 'Deletion failed'],
  ] as [Partial<Branch>, string][])('tags a branch %j as "%s"', async (state, label) => {
    renderList(makeClient([{ ...shownBranch, ...state }]));
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('shows no status tag for a ready branch', async () => {
    renderList(makeClient([{ ...shownBranch, filesystem_status: 'ready' }]));
    await screen.findByText('feature/visible');
    expect(screen.queryByText(/Setup failed|Files removed|Deleting|Setting up/)).toBeNull();
  });

  it('fetches board-scoped branches without an archived filter', async () => {
    const client = makeClient([shownBranch, hiddenBranch]);
    renderList(client);

    await screen.findByText('feature/visible');

    const service = client.service('branches') as unknown as { findAll: ReturnType<typeof vi.fn> };
    expect(service.findAll).toHaveBeenCalledWith({
      query: { board_id: 'board-1', $limit: 1000 },
    });
  });

  it('refetches when a board object on this board changes (zone move)', async () => {
    // Start with the branch pinned to "In Review", then have the daemon patch
    // the board_object into "Done" and emit a board-objects event. Zone pinning
    // lives on board_objects, so no branch event fires — the list must still
    // pick up the new zone label.
    let current: Branch[] = [{ ...shownBranch, zone_label: 'In Review' } as Branch];
    const { client, emit, findAll } = makeEmittingClient(() => current);

    renderList(client);

    expect(await screen.findByText('In Review')).toBeInTheDocument();
    expect(findAll).toHaveBeenCalledTimes(1);

    current = [{ ...shownBranch, zone_label: 'Done' } as Branch];
    act(() => {
      emit('board-objects', 'patched', {
        object_id: 'obj-1',
        board_id: 'board-1',
        branch_id: 'branch-shown',
      } as BoardEntityObject);
    });

    expect(await screen.findByText('Done')).toBeInTheDocument();
    expect(findAll).toHaveBeenCalledTimes(2);
  });

  it('ignores board object events for other boards', async () => {
    const { client, emit, findAll } = makeEmittingClient(() => [shownBranch]);

    renderList(client);
    await screen.findByText('feature/visible');
    expect(findAll).toHaveBeenCalledTimes(1);

    act(() => {
      emit('board-objects', 'patched', {
        object_id: 'obj-2',
        board_id: 'other-board',
        branch_id: 'branch-elsewhere',
      } as BoardEntityObject);
    });

    // No refetch for a different board.
    await waitFor(() => expect(findAll).toHaveBeenCalledTimes(1));
  });

  it('pans the board camera to the branch card when a row is clicked', async () => {
    const recenter = vi.fn().mockReturnValue(true);
    renderList(makeClient([shownBranch]), recenter);

    fireEvent.click(await screen.findByText('feature/visible'));

    // useRecenterMap forwards a sub-target options object as the second arg
    // (sessionId/ensureVisible); the branch id is all this row cares about.
    expect(recenter).toHaveBeenCalledWith('branch-shown', expect.anything());
  });

  it.each([
    { branches: [], text: 'No branches on this board yet.', footer: '0 branches' },
    { branches: [shownBranch], text: 'feature/visible', footer: '1 branch' },
    { branches: [shownBranch, hiddenBranch], text: 'feature/visible', footer: '2 branches' },
  ])('shows "$footer" once loaded', async ({ branches, text, footer }) => {
    renderList(makeClient(branches));

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByText(footer)).toBeInTheDocument();
  });

  it('shows a skeleton, not the empty state, while there is no client', () => {
    renderList(null);

    expect(screen.queryByText('No branches on this board yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('0 branches')).not.toBeInTheDocument();
  });

  it('reports a first-load failure without a count and loads again on Try again', async () => {
    const client = makeClient([shownBranch]);
    const service = client.service('branches') as unknown as {
      findAll: ReturnType<typeof vi.fn>;
    };
    service.findAll.mockRejectedValueOnce(new Error('Request timed out'));
    renderList(client);

    expect(await screen.findByText("Couldn't load branches.")).toBeInTheDocument();
    expect(screen.queryByText('0 branches')).not.toBeInTheDocument();
    expect(screen.queryByText('No branches on this board yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText('Request timed out')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('feature/visible')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load branches.")).not.toBeInTheDocument();
  });

  it('keeps the last list under a warning when a refresh fails', async () => {
    let fail = false;
    const { client, emit, findAll } = makeEmittingClient(() => [shownBranch]);
    findAll.mockImplementation(() =>
      fail ? Promise.reject(new Error('Request timed out')) : Promise.resolve([shownBranch])
    );
    renderList(client);
    await screen.findByText('feature/visible');

    fail = true;
    act(() => {
      emit('branches', 'patched', shownBranch);
    });

    expect(
      await screen.findByText("Couldn't refresh branches. This list may be out of date.")
    ).toBeInTheDocument();
    expect(screen.getByText('feature/visible')).toBeInTheDocument();
    expect(screen.getByText('1 branch')).toBeInTheDocument();
  });
});
