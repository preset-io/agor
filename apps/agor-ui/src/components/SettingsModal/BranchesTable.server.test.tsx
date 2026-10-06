/**
 * Settings → Branches pages from the daemon: with the store's branch and
 * session maps empty (as after Step 3 drops global hydration), the table
 * still lists every branch, pages and searches on the server, and counts
 * sessions with count-only reads.
 */
import { EventEmitter } from 'node:events';
import type { AgorClient, Branch, Repo } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '@/store/agorStore';
import { setRealtimeAuthorityScope } from '@/store/realtimeBatch';
import { BranchesTable } from './BranchesTable';

const repo = { repo_id: 'repo-1', name: 'repo-1', slug: 'org/repo-1' } as unknown as Repo;
const branch = (n: number, overrides: Partial<Branch> = {}) =>
  ({
    branch_id: `branch-${n}`,
    name: `feature-${n}`,
    ref: `feature-${n}`,
    repo_id: 'repo-1',
    path: `/tmp/feature-${n}`,
    archived: false,
    created_at: new Date(2026, 0, n).toISOString(),
    ...overrides,
  }) as unknown as Branch;

function makeClient(total = 25) {
  const branches = new EventEmitter();
  const branchesFind = vi.fn(async ({ query }: { query: Record<string, number> }) => ({
    total,
    limit: query.$limit,
    skip: query.$skip,
    data: Array.from({ length: Math.min(query.$limit, total - query.$skip) }, (_, i) =>
      branch(query.$skip + i + 1)
    ),
  }));
  const sessionsFind = vi.fn(async ({ query }: { query: { branch_id: string } }) => ({
    total: query.branch_id === 'branch-1' ? 3 : 0,
    limit: 0,
    skip: 0,
    data: [],
  }));
  const client = {
    service: (name: string) =>
      name === 'branches'
        ? {
            find: branchesFind,
            on: (e: string, fn: (...a: unknown[]) => void) => branches.on(e, fn),
            off: (e: string, fn: (...a: unknown[]) => void) => branches.off(e, fn),
          }
        : { find: sessionsFind, on: () => {}, off: () => {} },
  } as unknown as AgorClient;
  const emit = (event: string, payload: unknown) => act(() => void branches.emit(event, payload));
  return { client, branchesFind, sessionsFind, emit };
}

beforeEach(() => setRealtimeAuthorityScope('me:member:1'));
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
});

function renderTable(client: AgorClient) {
  render(
    <MemoryRouter>
      <BranchesTable
        client={client}
        branchById={new Map()}
        repoById={new Map([[repo.repo_id, repo]])}
        boardById={new Map()}
        sessionsByBranch={new Map()}
      />
    </MemoryRouter>
  );
}

describe('BranchesTable — server pages with the store empty', { timeout: 10_000 }, () => {
  it('lists the daemon page and its total, with server session counts', async () => {
    const { client, branchesFind, sessionsFind } = makeClient();
    renderTable(client);

    expect(await screen.findByText('feature-1')).toBeInTheDocument();
    expect(branchesFind).toHaveBeenCalledWith({
      query: { archived: false, $limit: 10, $skip: 0, $sort: { created_at: -1 } },
    });
    // The total comes from the server, not from the rows on hand.
    expect(screen.getByTitle('3')).toBeInTheDocument();
    expect(sessionsFind).toHaveBeenCalledWith({
      query: { branch_id: 'branch-1', archived: false, $limit: 0 },
    });
    expect(await screen.findByText('3 sessions')).toBeInTheDocument();
  });

  it('pages with $skip and searches with the server `search` key', async () => {
    const { client, branchesFind } = makeClient();
    renderTable(client);
    await screen.findByText('feature-1');

    fireEvent.click(screen.getByTitle('2'));
    expect(await screen.findByText('feature-11')).toBeInTheDocument();
    expect(branchesFind).toHaveBeenLastCalledWith({
      query: { archived: false, $limit: 10, $skip: 10, $sort: { created_at: -1 } },
    });

    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: 'feat' } });
    await waitFor(() =>
      expect(branchesFind).toHaveBeenLastCalledWith({
        query: { archived: false, search: 'feat', $limit: 10, $skip: 0, $sort: { created_at: -1 } },
      })
    );
    // The search starts on page 1 in the same update: no read of its page 2.
    expect(branchesFind).not.toHaveBeenCalledWith({
      query: expect.objectContaining({ search: 'feat', $skip: 10 }),
    });
  });

  it('sends the daemon at most its 8 distinct search terms', async () => {
    const { client, branchesFind } = makeClient();
    renderTable(client);
    await screen.findByText('feature-1');
    fireEvent.change(screen.getByPlaceholderText(/Search/), {
      target: { value: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' },
    });
    await waitFor(() =>
      expect(branchesFind).toHaveBeenLastCalledWith({
        query: {
          archived: false,
          search: 'alpha beta gamma delta epsilon zeta eta theta',
          $limit: 10,
          $skip: 0,
          $sort: { created_at: -1 },
        },
      })
    );
  });

  it('applies a realtime patch to a visible row in place', async () => {
    const { client, branchesFind, emit } = makeClient();
    renderTable(client);
    await screen.findByText('feature-1');
    const reads = branchesFind.mock.calls.length;

    emit('patched', branch(1, { name: 'renamed' }));
    expect(await screen.findByText('renamed')).toBeInTheDocument();
    expect(branchesFind).toHaveBeenCalledTimes(reads);

    // Archiving moves the row out of the Active filter: the page is read again.
    emit('patched', branch(2, { archived: true }));
    await waitFor(() => expect(branchesFind).toHaveBeenCalledTimes(reads + 1));
  });
});
