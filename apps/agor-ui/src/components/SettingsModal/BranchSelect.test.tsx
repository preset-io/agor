/**
 * The gateway BranchSelect reads its options from the daemon (debounced
 * `search`), so it works with the store's branch map empty (Step 3).
 */
import type { AgorClient, Branch } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { withTestAuthority } from '../../test/harness';
import { BranchSelect } from './BranchSelect';

const branch = (id: string, name: string, archived = false) =>
  ({ branch_id: id, name, ref: name, archived }) as unknown as Branch;

function makeClient(get = vi.fn(async (id: string) => branch(id, 'saved-target', true))) {
  const find = vi.fn(async ({ query }: { query: { search?: string } }) => ({
    total: 1,
    limit: 50,
    skip: 0,
    data: [query.search ? branch('b-2', 'matching') : branch('b-1', 'first')],
  }));
  const client = { service: () => ({ find, get }) } as unknown as AgorClient;
  return { client, find, get };
}

describe('BranchSelect', { timeout: 10_000 }, () => {
  withTestAuthority();
  it('offers the daemon page and searches with the server `search` key', async () => {
    const { client, find } = makeClient();
    render(<BranchSelect client={client} />);
    await waitFor(() =>
      expect(find).toHaveBeenCalledWith({
        query: { archived: false, $limit: 50, $sort: { name: 1 } },
      })
    );
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(await screen.findByTitle('first')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'match' } });
    await waitFor(() =>
      expect(find).toHaveBeenLastCalledWith({
        query: { archived: false, search: 'match', $limit: 50, $sort: { name: 1 } },
      })
    );
    expect(await screen.findByTitle('matching')).toBeInTheDocument();
  });

  it('sends the daemon at most its 8 distinct search terms', async () => {
    const { client, find } = makeClient();
    render(<BranchSelect client={client} />);
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' },
    });
    await waitFor(() =>
      expect(find).toHaveBeenLastCalledWith({
        query: {
          archived: false,
          search: 'alpha beta gamma delta epsilon zeta eta theta',
          $limit: 50,
          $sort: { name: 1 },
        },
      })
    );
  });

  it('labels a saved value outside the page with one by-id read', async () => {
    const { client, get } = makeClient();
    const { rerender } = render(<BranchSelect client={client} value="b-9" />);
    expect(await screen.findByText('saved-target (archived)')).toBeInTheDocument();
    rerender(<BranchSelect client={client} value="b-9" disabled />);
    expect(get).toHaveBeenCalledExactlyOnceWith('b-9');
  });

  it('keeps the bare id when the saved target is not readable', async () => {
    const get = vi.fn(async () => {
      throw new Error('Forbidden');
    });
    const { client } = makeClient(get);
    render(<BranchSelect client={client} value="hidden-target" />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('hidden-target'));
    expect(screen.getByText('hidden-target')).toBeInTheDocument();
  });
});
