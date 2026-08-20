import type { SessionID } from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { sessionPath } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPromptDraft } from '../../utils/promptDrafts';
import { CatalogTab } from './CatalogTab';

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const SESSION_ID = '019fd25a-7065-75f8-b6e6-f1963f9817d6';
const CURRENT_USER_ID = '019fd25a-7065-75f8-b6e6-f1963f9817d7';

const DEEPWIKI = {
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  category: 'dev-tools',
  benefit: 'Ask questions about any public GitHub repository.',
  permission_disclosure: 'Reads public GitHub repository content only.',
  starter_prompt: 'Explain how authentication works in a repo I name.',
  capabilities: ['docs', 'code-search'],
  has_remote: true,
  remote_url: 'https://mcp.deepwiki.com/mcp',
  transport: 'streamable-http',
  auth_type: 'none',
};

const LINEAR = {
  ...DEEPWIKI,
  name: 'app.linear/linear',
  title: 'Linear',
  permission_disclosure: 'Reads and writes issues in the Linear workspaces you authorise.',
};

/**
 * Every catalog read the page makes, in call order.
 *
 * The service takes no query and returns the whole catalog, so this exists to
 * assert *how many* reads happen — that filtering and paging cost none, and
 * that nothing is read before the socket can answer.
 */
let catalogReads: Array<Record<string, unknown> | undefined>;
let catalogRows: (typeof DEEPWIKI)[];
let connectCalls: Array<Record<string, unknown>>;
let connectImpl: (data: Record<string, unknown>) => Promise<unknown>;
let catalogFindError: Error | null;
let memberPolicyAnswer: {
  policy: 'use_existing_only' | 'allow_private_only' | 'allow_crud';
  can_configure: boolean;
};

function makeClient(): AgorClient {
  const service = (path: string) => {
    if (path === 'mcp-catalog') {
      return {
        // Deliberately unfiltered, whatever it is passed: the browser does the
        // narrowing now, using the same `filterCatalog` the daemon uses. A mock
        // that filtered would be testing itself rather than the component.
        find: async (params?: { query?: Record<string, unknown> }) => {
          catalogReads.push(params?.query);
          if (catalogFindError) throw catalogFindError;
          return {
            total: catalogRows.length,
            limit: catalogRows.length,
            skip: 0,
            data: catalogRows,
          };
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
    if (path === 'mcp-member-policy') {
      return { find: async () => memberPolicyAnswer };
    }
    throw new Error(`unexpected service: ${path}`);
  };
  return { service } as unknown as AgorClient;
}

function renderTab({
  connected = true,
  currentUser = { user_id: CURRENT_USER_ID, email: 'admin@agor.live', role: 'admin' } as User,
}: {
  connected?: boolean;
  currentUser?: User | null;
} = {}) {
  return render(
    <MemoryRouter>
      <CatalogTab client={makeClient()} connected={connected} currentUser={currentUser} />
    </MemoryRouter>
  );
}

/**
 * A card, found by the label its accessible name is computed from.
 *
 * `*ByRole` resolves a role for every element in the tree and calls
 * `getComputedStyle` on each to decide whether it is exposed. Against the
 * ~340KB of CSS antd injects into jsdom that is 300-700ms over a freshly
 * mounted subtree, and `findBy` allows 1000ms in total — so two polls exhaust
 * the wait even though the card has been in the DOM since ~60ms, and the
 * assertion turns on how loaded the runner is rather than on the component.
 * `aria-label` is the attribute that name is computed from, and costs ~3ms.
 *
 * The role itself is asserted in `renders a card per entry`, once, off the
 * polling path.
 */
const findCard = (title: string) => screen.findByLabelText(`Open ${title}`);
const queryCard = (title: string) => screen.queryByLabelText(`Open ${title}`);

/**
 * The open drawer. The disclosure is the one block it always renders, so it is
 * the cheap thing to wait on; the `dialog` role is then resolved once rather
 * than on every poll.
 */
async function findDrawer() {
  await screen.findByText('What this can access');
  return within(screen.getByRole('dialog'));
}

beforeEach(() => {
  catalogReads = [];
  catalogRows = [DEEPWIKI, LINEAR];
  catalogFindError = null;
  connectCalls = [];
  memberPolicyAnswer = { policy: 'allow_crud', can_configure: true };
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
    await findCard('DeepWiki');
    // The one place the role itself is the claim, so the one place that pays
    // for resolving it — and off the polling path, where the cost is a single
    // query rather than one per attempt.
    expect(screen.getByRole('button', { name: 'Open DeepWiki' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Linear' })).toBeInTheDocument();
  });

  it('reads nothing until the socket can answer, and never calls that an empty catalog', async () => {
    // The cold path: `/marketplace` as the entry URL. `client` exists from the
    // moment the socket is being built, so a surface that fetches on its
    // presence asks an unauthenticated socket and is refused.
    const { container } = renderTab({ connected: false });
    // Let any effect that was going to fire, fire.
    await act(() => Promise.resolve());

    expect(catalogReads).toHaveLength(0);
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
    expect(catalogReads).toHaveLength(0);

    rerender(
      <MemoryRouter>
        <CatalogTab client={client} connected={true} />
      </MemoryRouter>
    );

    expect(await findCard('DeepWiki')).toBeInTheDocument();
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

    expect(await findCard('DeepWiki')).toBeInTheDocument();
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
    await findCard('DeepWiki');

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

    expect(await findCard('DeepWiki')).toBeInTheDocument();
  });

  it('reads the catalog once and filters what it holds, with no query', async () => {
    renderTab();
    await findCard('DeepWiki');

    // One read, carrying nothing. The old surface sent `search`/`$limit`/`$skip`
    // and made a second request whose only purpose was to learn the total.
    expect(catalogReads).toEqual([undefined]);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), {
      target: { value: 'deep' },
    });

    await waitFor(() => expect(queryCard('Linear')).not.toBeInTheDocument());
    expect(queryCard('DeepWiki')).toBeInTheDocument();
    // Filtering cost no further reads.
    expect(catalogReads).toEqual([undefined]);
  });

  it('hides the match count until something is actually filtering (REQ-CAT-3)', async () => {
    renderTab();
    await findCard('DeepWiki');
    expect(screen.queryByText(/servers match/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), {
      target: { value: 'deep' },
    });
    expect(await screen.findByText('1 of 2 servers match')).toBeInTheDocument();
  });

  it('offers every entry whatever auth it states, and no longer filters on it', async () => {
    // The "Hide key-only" switch is gone with the thing it hid: an entry
    // needing an API key is installed from the drawer like any other, so there
    // is no unusable subset left for a filter to remove. A switch that cannot
    // change the result set reads as a broken filter.
    catalogRows = [
      { ...DEEPWIKI, auth_type: 'credentials' },
      { ...LINEAR, auth_type: 'unknown' },
    ];
    renderTab();

    expect(await findCard('DeepWiki')).toBeInTheDocument();
    expect(queryCard('Linear')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /API key/i })).not.toBeInTheDocument();
  });

  it('narrows on the keystroke, with no debounce and no round trip', async () => {
    renderTab();
    await findCard('DeepWiki');
    const before = catalogReads.length;

    const input = screen.getByRole('textbox', { name: 'Search MCP servers' });
    for (const value of ['d', 'de', 'dee', 'deep']) {
      fireEvent.change(input, { target: { value } });
    }

    // No timer to advance: 'deep' matches DeepWiki's name and not Linear's, and
    // the grid has already settled. The debounce existed to spare the server a
    // request per keystroke; there is no request now.
    await waitFor(() => expect(queryCard('Linear')).not.toBeInTheDocument());
    expect(queryCard('DeepWiki')).toBeInTheDocument();
    expect(catalogReads.length).toBe(before);
  });

  it('searches title and description, not just name', async () => {
    // The server searched name, title and description. The browser has to search
    // the same three, or a term that used to find a server silently stops.
    catalogRows = [
      { ...DEEPWIKI, title: 'DeepWiki', description: 'Ask about a repository.' },
      { ...LINEAR, title: 'Linear', description: 'Track issues and projects.' },
    ] as typeof catalogRows;
    renderTab();
    await findCard('DeepWiki');

    const input = screen.getByRole('textbox', { name: 'Search MCP servers' });

    // Matched on `description` alone: the term is in neither name nor title.
    fireEvent.change(input, { target: { value: 'projects' } });
    await waitFor(() => expect(queryCard('DeepWiki')).not.toBeInTheDocument());
    expect(queryCard('Linear')).toBeInTheDocument();

    // Matched on `title`, case-insensitively and partially.
    fireEvent.change(input, { target: { value: 'DEEPW' } });
    await waitFor(() => expect(queryCard('Linear')).not.toBeInTheDocument());
    expect(queryCard('DeepWiki')).toBeInTheDocument();
  });

  it('pages the entries it holds without reading again', async () => {
    // 30 entries is more than one 24-entry page.
    catalogRows = Array.from({ length: 30 }, (_, index) => ({
      ...DEEPWIKI,
      name: `com.entry-${String(index).padStart(2, '0')}/mcp`,
      title: `Entry ${String(index).padStart(2, '0')}`,
    }));
    renderTab();
    await findCard('Entry 00');
    expect(queryCard('Entry 29')).not.toBeInTheDocument();
    const before = catalogReads.length;

    fireEvent.click(screen.getByTitle('2'));

    expect(await findCard('Entry 29')).toBeInTheDocument();
    expect(queryCard('Entry 00')).not.toBeInTheDocument();
    expect(catalogReads.length).toBe(before);
  });
});

describe('connect', () => {
  async function openDrawer() {
    renderTab();
    fireEvent.click(await findCard('DeepWiki'));
    return findDrawer();
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

  it('connects by catalog key alone and lands in the new session with the prompt loaded', async () => {
    const drawer = await openDrawer();
    const connect = drawer.getByRole('button', { name: /Connect/ });
    fireEvent.click(drawer.getByRole('checkbox'));
    await waitFor(() => expect(connect).toBeEnabled());

    fireEvent.click(connect);

    await waitFor(() => expect(connectCalls).toHaveLength(1));
    expect(connectCalls[0]).toEqual({
      catalog_key: 'com.deepwiki/mcp',
      branch_id: 'branch-1',
      agentic_tool: 'claude-code',
      // The exact text the drawer rendered, so the daemon can refuse a connect
      // that skipped the disclosure or is holding a stale one.
      acknowledged_disclosure: DEEPWIKI.permission_disclosure,
    });

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(sessionPath(SESSION_ID as SessionID))
    );
    expect(getPromptDraft(CURRENT_USER_ID, SESSION_ID)).toBe(DEEPWIKI.starter_prompt);
  });

  /**
   * A new OAuth install with no reusable grant lands without credentials. A
   * starter prompt is written to exercise the server it ships with, so arming
   * the composer with one here means pressing Connect produces a loaded prompt
   * whose only result is a tool-less answer.
   *
   * These pin the split. Landing in the session is unchanged: the session is
   * where the sign-in lives (the notice above the composer, the warning MCP badge,
   * the pill that starts OAuth on activation). Only the loaded gun is withheld.
   */
  async function connectAndLand(mcpServer: Record<string, unknown>) {
    connectImpl = async () => ({
      mcp_server: mcpServer,
      session: { session_id: SESSION_ID },
      starter_prompt: DEEPWIKI.starter_prompt,
      reused_existing_server: false,
    });
    const drawer = await openDrawer();
    const connect = drawer.getByRole('button', { name: /Connect/ });
    fireEvent.click(drawer.getByRole('checkbox'));
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(sessionPath(SESSION_ID as SessionID))
    );
  }

  it('does not arm the composer when the install still needs signing in', async () => {
    await connectAndLand({ mcp_server_id: 'server-1', auth: { type: 'oauth' } });

    expect(getPromptDraft(CURRENT_USER_ID, SESSION_ID)).toBe('');
  });

  it('still lands in the session so the sign-in is reachable', async () => {
    await connectAndLand({ mcp_server_id: 'server-1', auth: { type: 'oauth' } });

    // Withholding the prompt must not withhold the session: the MCP badge and
    // the pill that starts OAuth are both inside it.
    expect(mockNavigate).toHaveBeenCalledWith(sessionPath(SESSION_ID as SessionID));
    expect(connectCalls).toHaveLength(1);
  });

  it('arms the composer when a reused install already holds a live token', async () => {
    // A reused install comes back through `mcp-servers` find, where the daemon
    // injects the caller's token — redacted to a sentinel, but present, which
    // is all "is this finished" needs.
    await connectAndLand({
      mcp_server_id: 'server-1',
      auth: {
        type: 'oauth',
        oauth_access_token: '••••••••',
        oauth_token_expires_at: 4102444800000,
      },
    });

    expect(getPromptDraft(CURRENT_USER_ID, SESSION_ID)).toBe(DEEPWIKI.starter_prompt);
  });

  it('withholds the prompt when the token the install carries has expired', async () => {
    await connectAndLand({
      mcp_server_id: 'server-1',
      auth: {
        type: 'oauth',
        oauth_access_token: '••••••••',
        oauth_token_expires_at: 1,
      },
    });

    expect(getPromptDraft(CURRENT_USER_ID, SESSION_ID)).toBe('');
  });

  it('keeps the drawer open and reports why when connect fails', async () => {
    connectImpl = async () => {
      throw new Error('DeepWiki is temporarily unavailable');
    };
    const drawer = await openDrawer();
    const connect = drawer.getByRole('button', { name: /Connect/ });
    fireEvent.click(drawer.getByRole('checkbox'));
    await waitFor(() => expect(connect).toBeEnabled());

    fireEvent.click(connect);

    expect(await drawer.findByText(/temporarily unavailable/)).toBeVisible();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('offers no connect control for an entry with no endpoint', async () => {
    // The loader refuses such an entry now, so nothing served reaches this.
    // Kept because the drawer renders whatever the wire hands it, and offering
    // a Connect button over an entry with nothing to connect to is the failure
    // this guards.
    catalogRows = [{ ...DEEPWIKI, has_remote: false, remote_url: undefined }];
    renderTab();
    fireEvent.click(await findCard('DeepWiki'));
    const drawer = await findDrawer();

    expect(drawer.getByText(/cannot be installed/)).toBeVisible();
    expect(drawer.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
    expect(drawer.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('connect capability reaches the drawer', () => {
  const VIEWER = {
    user_id: 'user-viewer',
    email: 'viewer@agor.live',
    role: 'viewer',
  } as User;
  const MEMBER = {
    user_id: 'user-member',
    email: 'member@agor.live',
    role: 'member',
  } as User;

  async function openAndAcknowledge(currentUser: User) {
    renderTab({ currentUser });
    fireEvent.click(await findCard('DeepWiki'));
    const drawer = await findDrawer();
    fireEvent.click(drawer.getByRole('checkbox'));
    return drawer;
  }

  it('refuses a viewer before any connect request reaches the daemon', async () => {
    memberPolicyAnswer = { policy: 'allow_crud', can_configure: false };

    const drawer = await openAndAcknowledge(VIEWER);

    await waitFor(() => expect(drawer.getByRole('button', { name: /Connect/ })).toBeDisabled());
    expect(drawer.getByText(/read-only access/i)).toBeInTheDocument();
    expect(connectCalls).toHaveLength(0);
  });

  it('refuses a member when the server says the policy is use-existing-only', async () => {
    memberPolicyAnswer = { policy: 'use_existing_only', can_configure: false };

    const drawer = await openAndAcknowledge(MEMBER);

    await waitFor(() => expect(drawer.getByRole('button', { name: /Connect/ })).toBeDisabled());
    expect(drawer.getByText(/Use existing servers only/)).toBeInTheDocument();
    expect(connectCalls).toHaveLength(0);
  });

  it('enables Connect when the server grants the member capability', async () => {
    memberPolicyAnswer = { policy: 'allow_private_only', can_configure: true };

    const drawer = await openAndAcknowledge(MEMBER);

    await waitFor(() => expect(drawer.getByRole('button', { name: /Connect/ })).toBeEnabled());
  });
});
