import type { SessionID } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { sessionPath } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogTab } from './CatalogTab';

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const SESSION_ID = '019fd25a-7065-75f8-b6e6-f1963f9817d6';

const DEEPWIKI = {
  catalog_entry_id: 'entry-deepwiki',
  created_at: new Date(0),
  updated_at: new Date(0),
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  benefit: 'Ask questions about any public GitHub repository.',
  permission_disclosure: 'Reads public GitHub repository content only.',
  starter_prompt: 'Explain how authentication works in a repo I name.',
  capabilities: ['docs', 'code-search'],
  has_remote: true,
  has_package: false,
  curated: true,
  verified: false,
  remote_url: 'https://mcp.deepwiki.com/mcp',
  transport: 'streamable-http',
  probed_auth_type: 'none',
};

const LINEAR = {
  ...DEEPWIKI,
  catalog_entry_id: 'entry-linear',
  name: 'app.linear/linear',
  title: 'Linear',
  permission_disclosure: 'Reads and writes issues in the Linear workspaces you authorise.',
};

/** Every catalog read the page makes, in call order, so queries can be asserted. */
let catalogQueries: Array<Record<string, unknown>>;
let catalogRows: (typeof DEEPWIKI)[];
let connectCalls: Array<Record<string, unknown>>;
let connectImpl: (data: Record<string, unknown>) => Promise<unknown>;
let catalogFindError: Error | null;

function makeClient(): AgorClient {
  const service = (path: string) => {
    if (path === 'mcp-catalog') {
      return {
        find: async ({ query }: { query: Record<string, unknown> }) => {
          catalogQueries.push(query);
          if (catalogFindError) throw catalogFindError;
          const verdicts = query.probed_auth_types as string[] | undefined;
          const filtered = catalogRows
            .filter((row) =>
              typeof query.search === 'string'
                ? row.name.toLowerCase().includes(String(query.search).toLowerCase())
                : true
            )
            .filter((row) => (verdicts ? verdicts.includes(row.probed_auth_type) : true));
          return { total: filtered.length, limit: 24, skip: 0, data: filtered };
        },
      };
    }
    if (path === 'branches') {
      return {
        findAll: async () => [{ branch_id: 'branch-1', name: 'mkt-slice' }],
      };
    }
    if (path === 'mcp-catalog/connect') {
      return {
        create: async (data: Record<string, unknown>) => {
          connectCalls.push(data);
          return connectImpl(data);
        },
      };
    }
    throw new Error(`unexpected service: ${path}`);
  };
  return { service } as unknown as AgorClient;
}

function renderTab({ connected = true }: { connected?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <CatalogTab client={makeClient()} connected={connected} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  catalogQueries = [];
  catalogRows = [DEEPWIKI, LINEAR];
  catalogFindError = null;
  connectCalls = [];
  connectImpl = async () => ({
    mcp_server: { mcp_server_id: 'server-1' },
    session: { session_id: SESSION_ID },
    starter_prompt: DEEPWIKI.starter_prompt,
    reused_existing_server: false,
  });
  mockNavigate.mockClear();
  localStorage.clear();
});

describe('catalog browsing', () => {
  it('renders a card per entry', async () => {
    renderTab();
    expect(await screen.findByRole('button', { name: 'Open DeepWiki' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Linear' })).toBeInTheDocument();
  });

  it('reads nothing until the socket can answer, and never calls that an empty catalog', async () => {
    // The cold path: `/marketplace` as the entry URL. `client` exists from the
    // moment the socket is being built, so a surface that fetches on its
    // presence asks an unauthenticated socket and is refused.
    const { container } = renderTab({ connected: false });
    // Let any effect that was going to fire, fire.
    await act(() => Promise.resolve());

    expect(catalogQueries).toHaveLength(0);
    expect(container.querySelectorAll('.ant-skeleton').length).toBeGreaterThan(0);
    expect(screen.queryByText('No servers match')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not load the catalog')).not.toBeInTheDocument();
  });

  it('says the daemon is unreachable rather than spinning silently', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderTab({ connected: false });
      await act(() => Promise.resolve());
      expect(screen.queryByText('Not connected to the Agor daemon')).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(screen.getByText('Not connected to the Agor daemon')).toBeVisible();
      expect(screen.queryByText('No servers match')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads once the socket connects, without a remount', async () => {
    const client = makeClient();
    const { rerender } = render(
      <MemoryRouter>
        <CatalogTab client={client} connected={false} />
      </MemoryRouter>
    );
    expect(catalogQueries).toHaveLength(0);

    rerender(
      <MemoryRouter>
        <CatalogTab client={client} connected={true} />
      </MemoryRouter>
    );

    expect(await screen.findByRole('button', { name: 'Open DeepWiki' })).toBeInTheDocument();
  });

  it('renders a failed read as a failure, not as an empty catalog', async () => {
    catalogFindError = new Error('NotAuthenticated: Authentication required');
    renderTab();

    expect(await screen.findByText('Could not load the catalog')).toBeVisible();
    expect(screen.getByText(/Authentication required/)).toBeVisible();
    expect(screen.queryByText('No servers match')).not.toBeInTheDocument();
  });

  it('recovers from a failed read when retried', async () => {
    catalogFindError = new Error('boom');
    renderTab();
    await screen.findByText('Could not load the catalog');

    catalogFindError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Open DeepWiki' })).toBeInTheDocument();
    expect(screen.queryByText('Could not load the catalog')).not.toBeInTheDocument();
  });

  it('does not blame filters for an empty catalog', async () => {
    // A fresh daemon answers /health for a minute or two before curation
    // finishes seeding. "No servers match" reads as "your filters excluded
    // everything" when nothing is filtering, which sends people hunting for a
    // frontend bug that isn't there.
    catalogRows = [];
    renderTab();

    expect(await screen.findByText('No servers in the catalog yet')).toBeVisible();
    expect(screen.queryByText('No servers match')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('still blames the filters when the filters are to blame', async () => {
    renderTab();
    await screen.findByRole('button', { name: 'Open DeepWiki' });

    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), {
      target: { value: 'nothing-matches-this' },
    });

    expect(await screen.findByText('No servers match')).toBeVisible();
    expect(screen.queryByText('No servers in the catalog yet')).not.toBeInTheDocument();
  });

  it('picks the catalog back up once seeding finishes', async () => {
    catalogRows = [];
    renderTab();
    await screen.findByText('No servers in the catalog yet');

    catalogRows = [DEEPWIKI, LINEAR];
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    expect(await screen.findByRole('button', { name: 'Open DeepWiki' })).toBeInTheDocument();
  });

  it('pushes filters and page bounds to the server rather than filtering in the browser', async () => {
    renderTab();
    await screen.findByRole('button', { name: 'Open DeepWiki' });

    const listQuery = catalogQueries.find((query) => query.$limit === 24);
    expect(listQuery).toMatchObject({ sort: 'popularity', $limit: 24, $skip: 0 });
  });

  it('hides the match count until something is actually filtering (REQ-CAT-3)', async () => {
    renderTab();
    await screen.findByRole('button', { name: 'Open DeepWiki' });
    expect(screen.queryByText(/servers match/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: /Reviewed by Preset/i }));
    expect(await screen.findByText('2 of 2 servers match')).toBeInTheDocument();
    expect(catalogQueries.some((query) => query.curated === true)).toBe(true);
  });

  it('keeps unprobed servers when hiding account-only ones', async () => {
    // A stock install has never run a registry sync, so every curated row is
    // `unknown`. A filter that demanded `none` could only ever return nothing,
    // while the cards beside it called those same entries connectable.
    catalogRows = [
      { ...DEEPWIKI, probed_auth_type: 'unknown' },
      { ...LINEAR, probed_auth_type: 'unknown' },
    ];
    renderTab();
    await screen.findByRole('button', { name: 'Open DeepWiki' });

    fireEvent.click(screen.getByRole('switch', { name: /known to need an account/i }));

    expect(await screen.findByText('2 of 2 servers match')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open DeepWiki' })).toBeInTheDocument();
    expect(screen.queryByText('No servers match')).not.toBeInTheDocument();
  });

  it('drops servers known to need an account', async () => {
    catalogRows = [
      { ...DEEPWIKI, probed_auth_type: 'unknown' },
      { ...LINEAR, probed_auth_type: 'oauth' },
    ];
    renderTab();
    await screen.findByRole('button', { name: 'Open Linear' });

    fireEvent.click(screen.getByRole('switch', { name: /known to need an account/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open Linear' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: 'Open DeepWiki' })).toBeInTheDocument();
    expect(catalogQueries.at(-1)?.probed_auth_types).toEqual(['none', 'unknown']);
  });

  it('debounces search into one server-side query', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderTab();
      await screen.findByRole('button', { name: 'Open DeepWiki' });
      const before = catalogQueries.length;

      const input = screen.getByRole('textbox', { name: 'Search MCP servers' });
      for (const value of ['d', 'de', 'dee', 'deep']) {
        fireEvent.change(input, { target: { value } });
      }
      expect(catalogQueries.length).toBe(before);

      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() => expect(catalogQueries.length).toBe(before + 1));
      expect(catalogQueries.at(-1)).toMatchObject({ search: 'deep' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('connect', () => {
  async function openDrawer() {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Open DeepWiki' }));
    return within(await screen.findByRole('dialog'));
  }

  it('shows the access disclosure expanded and blocks connect until it is acknowledged', async () => {
    const drawer = await openDrawer();

    expect(drawer.getByText('What this can access')).toBeVisible();
    expect(drawer.getByText(DEEPWIKI.permission_disclosure)).toBeVisible();

    const connect = drawer.getByRole('button', { name: /Connect/ });
    expect(connect).toBeDisabled();

    fireEvent.click(drawer.getByRole('checkbox'));
    await waitFor(() => expect(connect).toBeEnabled());
  });

  // Consent's two withdrawal rules — a different entry, and the same entry
  // with rewritten wording — are asserted in `CatalogDetailDrawer.test.tsx`.
  // Reaching them from here meant closing and reopening the drawer, mounting
  // the AntD Form and its Selects twice; the drawer takes the entry as a prop
  // and states the same invariant in one mount.

  it('offers no connect control for an entry that discloses nothing', async () => {
    catalogRows = [{ ...DEEPWIKI, permission_disclosure: '' }];
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Open DeepWiki' }));
    const drawer = within(await screen.findByRole('dialog'));

    expect(drawer.getByText(/has not stated what it can access/)).toBeVisible();
    expect(drawer.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
  });

  it('connects by catalog key alone and lands in the new session with the prompt loaded', async () => {
    const drawer = await openDrawer();
    fireEvent.click(drawer.getByRole('checkbox'));
    await waitFor(() => expect(drawer.getByRole('button', { name: /Connect/ })).toBeEnabled());

    fireEvent.click(drawer.getByRole('button', { name: /Connect/ }));

    await waitFor(() => expect(connectCalls).toHaveLength(1));
    expect(connectCalls[0]).toEqual({
      catalog_key: 'entry-deepwiki',
      branch_id: 'branch-1',
      agentic_tool: 'claude-code',
      // The exact text the drawer rendered, so the daemon can refuse a connect
      // that skipped the disclosure or is holding a stale one.
      acknowledged_disclosure: DEEPWIKI.permission_disclosure,
    });

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(sessionPath(SESSION_ID as SessionID))
    );
    expect(localStorage.getItem(`agor-draft-${SESSION_ID}`)).toBe(DEEPWIKI.starter_prompt);
  });

  it('keeps the drawer open and reports why when connect fails', async () => {
    connectImpl = async () => {
      throw new Error('DeepWiki requires authentication, which is not supported yet');
    };
    const drawer = await openDrawer();
    fireEvent.click(drawer.getByRole('checkbox'));
    await waitFor(() => expect(drawer.getByRole('button', { name: /Connect/ })).toBeEnabled());

    fireEvent.click(drawer.getByRole('button', { name: /Connect/ }));

    expect(await drawer.findByText(/requires authentication/)).toBeVisible();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('offers no connect control for an entry that has not been reviewed', async () => {
    catalogRows = [{ ...DEEPWIKI, curated: false }];
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Open DeepWiki' }));
    const drawer = within(await screen.findByRole('dialog'));

    expect(drawer.getByText(/Only servers reviewed by Preset/)).toBeVisible();
    expect(drawer.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
    expect(drawer.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
