/**
 * Consent is the drawer's own rule, so it is asserted against the drawer.
 *
 * Driving it through `CatalogTab` meant closing and reopening to change which
 * entry is shown, which mounts the AntD Form and its Selects a second time —
 * the cost this package's vitest config already singles out. Here the entry is
 * a prop, so the same invariant is one mount, and a stronger statement: the
 * hazard is consent surviving a change of entry, and that is checked directly
 * rather than through a close/reopen that only approximates it.
 */

import type { Branch, MCPCatalogCredentialRequirement, MCPCatalogEntry } from '@agor/core/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type MCPServerCapabilityContext, POLICY_LOADING_HINT } from '../MCPServer/memberPolicy';
import { CatalogDetailDrawer } from './CatalogDetailDrawer';
import { getLastConnectBranchId, rememberConnectBranchId } from './useConnectTargets';

const ALLOWED: MCPServerCapabilityContext = {
  connectionReady: true,
  role: 'admin',
  isAdmin: true,
  policy: 'allow_crud',
  userId: 'user-admin',
  canConfigure: true,
};

const DEEPWIKI = {
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  category: 'dev-tools',
  benefit: 'Ask questions about any public GitHub repository.',
  permission_disclosure: 'Reads public GitHub repository content only.',
  capabilities: ['docs'],
  has_remote: true,
  remote_url: 'https://mcp.deepwiki.com/mcp',
  transport: 'streamable-http',
  auth_type: 'none',
} as unknown as MCPCatalogEntry;

const LINEAR = {
  ...DEEPWIKI,
  name: 'app.linear/linear',
  title: 'Linear',
  permission_disclosure: 'Reads and writes issues in the Linear workspaces you authorise.',
} as unknown as MCPCatalogEntry;

const OAUTH_LINEAR = { ...LINEAR, auth_type: 'oauth' } as MCPCatalogEntry;

const BRANCHES = [{ branch_id: 'branch-1', name: 'mkt-slice' }] as unknown as Branch[];

function renderDrawer(
  entry: MCPCatalogEntry,
  options: { capability?: MCPServerCapabilityContext; policyPending?: boolean } = {}
) {
  const { capability = ALLOWED, policyPending = false } = options;
  const view = render(
    <CatalogDetailDrawer
      identityKey={capability.userId ?? null}
      entry={entry}
      open
      onClose={vi.fn()}
      branches={BRANCHES}
      branchesLoading={false}
      branchesError={null}
      defaultBranchId="branch-1"
      connecting={false}
      connectError={null}
      connectCapability={capability}
      policyPending={policyPending}
      policyPendingHint={POLICY_LOADING_HINT}
      onConnect={vi.fn()}
    />
  );
  const show = (next: MCPCatalogEntry) =>
    view.rerender(
      <CatalogDetailDrawer
        identityKey={capability.userId ?? null}
        entry={next}
        open
        onClose={vi.fn()}
        branches={BRANCHES}
        branchesLoading={false}
        branchesError={null}
        defaultBranchId="branch-1"
        connecting={false}
        connectError={null}
        connectCapability={capability}
        policyPending={policyPending}
        policyPendingHint={POLICY_LOADING_HINT}
        onConnect={vi.fn()}
      />
    );
  return { show };
}

const connectButton = () => {
  const match = screen
    .getAllByText(/^(Connect with .+|Verify key & connect|Check & connect|Connect & try it)$/i)
    .find((node) => node.closest('button'));
  if (!match) throw new Error('Connect button not found');
  return match.closest('button')!;
};

function branchCombobox(): HTMLElement {
  const item = screen.getByText('Branch').closest('.ant-form-item');
  const input = item?.querySelector('[role="combobox"]');
  if (!(input instanceof HTMLElement)) throw new Error('Branch selector not found');
  return input;
}

function renderBranchDrawer({
  branches,
  defaultBranchId,
  loading = false,
}: {
  branches: Branch[];
  defaultBranchId: string | null;
  loading?: boolean;
}) {
  return render(
    <CatalogDetailDrawer
      identityKey="user-admin"
      entry={DEEPWIKI}
      open
      onClose={vi.fn()}
      branches={branches}
      branchesLoading={loading}
      branchesError={null}
      defaultBranchId={defaultBranchId}
      connecting={false}
      connectError={null}
      connectCapability={ALLOWED}
      policyPending={false}
      policyPendingHint={POLICY_LOADING_HINT}
      onConnect={vi.fn()}
    />
  );
}

describe('CatalogDetailDrawer branch destination', () => {
  const TWO_BRANCHES = [
    { branch_id: 'branch-1', name: 'First branch' },
    { branch_id: 'branch-2', name: 'Remembered branch' },
  ] as unknown as Branch[];

  it('selects the caller-persisted branch by default', async () => {
    localStorage.clear();
    rememberConnectBranchId('user-admin', 'branch-2');
    renderBranchDrawer({
      branches: TWO_BRANCHES,
      defaultBranchId: getLastConnectBranchId('user-admin'),
    });

    await waitFor(() =>
      expect(branchCombobox().parentElement).toHaveTextContent('Remembered branch')
    );
  });

  it('falls back to the first accessible branch when the preference is stale', async () => {
    renderBranchDrawer({ branches: TWO_BRANCHES, defaultBranchId: 'no-longer-visible' });

    await waitFor(() => expect(branchCombobox().parentElement).toHaveTextContent('First branch'));
    expect(branchCombobox().parentElement).not.toHaveTextContent('Remembered branch');
  });

  it('distinguishes a loading branch list from no accessible branches', async () => {
    const view = renderBranchDrawer({ branches: [], defaultBranchId: null, loading: true });
    expect(screen.getAllByText('Loading branches…').length).toBeGreaterThan(0);
    expect(connectButton()).toBeDisabled();

    view.rerender(
      <CatalogDetailDrawer
        identityKey="user-admin"
        entry={DEEPWIKI}
        open
        onClose={vi.fn()}
        branches={[]}
        branchesLoading={false}
        branchesError={null}
        defaultBranchId={null}
        connecting={false}
        connectError={null}
        connectCapability={ALLOWED}
        policyPending={false}
        policyPendingHint={POLICY_LOADING_HINT}
        onConnect={vi.fn()}
      />
    );

    expect(screen.getByText('Select a branch')).toBeVisible();
    fireEvent.mouseDown(branchCombobox());
    expect(await screen.findByText('No branches yet')).toBeInTheDocument();
    expect(connectButton()).toBeDisabled();
  });

  it('uses a fixed desktop target width that Ant Drawer can constrain to the viewport', () => {
    renderBranchDrawer({
      branches: TWO_BRANCHES,
      defaultBranchId: 'branch-1',
    });

    expect(document.querySelector('.ant-drawer-content-wrapper')).toHaveStyle({ width: '480px' });
  });
});

describe('CatalogDetailDrawer consent', () => {
  it('gates connect on the disclosure being acknowledged', () => {
    renderDrawer(DEEPWIKI);

    expect(screen.getByText(DEEPWIKI.permission_disclosure as string)).toBeVisible();
    expect(connectButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));

    expect(connectButton()).toBeEnabled();
  });

  it("does not carry one server's acknowledgement to the next one shown", () => {
    const { show } = renderDrawer(DEEPWIKI);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(connectButton()).toBeEnabled();

    show(LINEAR);

    expect(screen.getByText(LINEAR.permission_disclosure as string)).toBeVisible();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(connectButton()).toBeDisabled();
  });

  it('withdraws consent when the disclosure it was given for is rewritten', () => {
    // A reseed can rewrite what an entry discloses. Consent was given for the
    // old words, and the endpoint's contract is the text — so the same entry
    // saying something new has to be acknowledged again.
    const { show } = renderDrawer(DEEPWIKI);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(connectButton()).toBeEnabled();

    show({
      ...DEEPWIKI,
      permission_disclosure: 'Now also writes to your repositories.',
    } as MCPCatalogEntry);

    expect(screen.getByText('Now also writes to your repositories.')).toBeVisible();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(connectButton()).toBeDisabled();
  });
});

describe('CatalogDetailDrawer OAuth activation', () => {
  const renderOAuth = (
    onConnect = vi.fn(),
    options: { entry?: MCPCatalogEntry; readinessLoading?: boolean } = {}
  ) =>
    render(
      <CatalogDetailDrawer
        identityKey="user-admin"
        entry={options.entry ?? OAUTH_LINEAR}
        open
        onClose={vi.fn()}
        branches={BRANCHES}
        branchesLoading={false}
        branchesError={null}
        defaultBranchId="branch-1"
        connecting={false}
        connectError={null}
        readiness={
          options.readinessLoading
            ? null
            : { catalog_key: OAUTH_LINEAR.name, state: 'oauth_required' }
        }
        readinessLoading={options.readinessLoading}
        connectCapability={ALLOWED}
        policyPending={false}
        policyPendingHint={POLICY_LOADING_HINT}
        onConnect={onConnect}
      />
    );

  it('pre-opens a blank window in the click before handing control to Connect', () => {
    const popup = {
      opener: window,
      closed: false,
      close: vi.fn(),
      location: { replace: vi.fn() },
      document: { title: '', body: { textContent: '' } },
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    const onConnect = vi.fn();
    renderOAuth(onConnect);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(connectButton());
    expect(open).toHaveBeenCalledWith(
      'about:blank',
      expect.stringMatching(/^agor-mcp-oauth-/),
      'popup=yes,width=720,height=760'
    );
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        oauthPopup: expect.objectContaining({ close: expect.any(Function) }),
      })
    );
    open.mockRestore();
  });

  it('conservatively pre-opens on a fast click while readiness is still unknown', () => {
    const popup = {
      opener: window,
      closed: false,
      close: vi.fn(),
      location: { replace: vi.fn() },
      document: { title: '', body: { textContent: '' } },
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    const onConnect = vi.fn();
    renderOAuth(onConnect, { entry: DEEPWIKI, readinessLoading: true });

    fireEvent.click(screen.getByRole('checkbox'));
    expect(connectButton()).toBeEnabled();
    fireEvent.click(connectButton());

    expect(open).toHaveBeenCalledOnce();
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        oauthPopup: expect.objectContaining({ operationId: expect.any(String) }),
      })
    );
    open.mockRestore();
  });

  it('does not call Connect when the browser blocks the popup', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onConnect = vi.fn();
    renderOAuth(onConnect);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(connectButton());
    expect(onConnect).not.toHaveBeenCalled();
    expect(
      screen.getByText('Nothing was connected because the sign-in window could not be opened.')
    ).toBeVisible();
    open.mockRestore();
  });
});

describe('CatalogDetailDrawer connect capability', () => {
  const VIEWER: MCPServerCapabilityContext = {
    connectionReady: true,
    role: 'viewer',
    isAdmin: false,
    policy: 'allow_crud',
    userId: 'user-viewer',
    canConfigure: false,
  };
  const RESTRICTED_MEMBER: MCPServerCapabilityContext = {
    connectionReady: true,
    role: 'member',
    isAdmin: false,
    policy: 'use_existing_only',
    userId: 'user-member',
    canConfigure: false,
  };

  it('refuses a viewer at the action and explains the role restriction', () => {
    renderDrawer(DEEPWIKI, { capability: VIEWER });
    fireEvent.click(screen.getByRole('checkbox'));

    expect(connectButton()).toBeDisabled();
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument();
  });

  it('refuses a member when the workspace policy forbids new servers', () => {
    renderDrawer(DEEPWIKI, { capability: RESTRICTED_MEMBER });
    fireEvent.click(screen.getByRole('checkbox'));

    expect(connectButton()).toBeDisabled();
    expect(screen.getByText(/Use existing servers only/)).toBeInTheDocument();
  });

  it('enables the action for a member with server-provided capability', () => {
    renderDrawer(DEEPWIKI, {
      capability: { ...RESTRICTED_MEMBER, policy: 'allow_crud', canConfigure: true },
    });
    fireEvent.click(screen.getByRole('checkbox'));

    expect(connectButton()).toBeEnabled();
  });

  it('fails closed during disconnect grace even with a previously granted capability', () => {
    renderDrawer(DEEPWIKI, {
      capability: {
        ...RESTRICTED_MEMBER,
        connectionReady: false,
        policy: 'allow_crud',
        canConfigure: true,
      },
    });
    fireEvent.click(screen.getByRole('checkbox'));

    expect(connectButton()).toBeDisabled();
  });

  it('fails closed without inventing a workspace policy while the read is pending', () => {
    renderDrawer(DEEPWIKI, { policyPending: true });
    fireEvent.click(screen.getByRole('checkbox'));

    expect(connectButton()).toBeDisabled();
    expect(screen.getByText(POLICY_LOADING_HINT)).toBeInTheDocument();
    expect(screen.queryByText(/does not let you add/i)).not.toBeInTheDocument();
  });
});

/**
 * The API-key field.
 *
 * The drawer is the only place a key is ever typed, so two of its rules are
 * load-bearing rather than cosmetic: the field appears exactly for entries that
 * ask for one, and what is typed belongs to the entry it was typed for. The
 * second is the sharper one — a key left in the field across a change of entry
 * would be one vendor's credential sent to another vendor's endpoint, and the
 * drawer stays open across that change.
 *
 * The keys here are obvious fakes.
 */
const GITHUB = {
  ...DEEPWIKI,
  name: 'io.github.github/github-mcp-server',
  title: 'GitHub',
  permission_disclosure: 'Reads repositories and issues you authorise.',
  website_url: 'https://docs.github.com/authentication/keeping-your-account-and-data-secure/',
  auth_type: 'credentials',
  credentials: {
    scheme: 'bearer',
    label: 'Fine-grained personal access token',
    acquisition_url:
      'https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    oauth_challenge_compatible: true,
  },
} as unknown as MCPCatalogEntry;

const SENTRY = {
  ...GITHUB,
  name: 'io.sentry/mcp',
  title: 'Sentry',
  permission_disclosure: 'Reads issues and events from the Sentry organisations you authorise.',
  credentials: {
    scheme: 'bearer',
    label: 'Personal access token',
    acquisition_url: 'https://docs.sentry.io/account/auth-tokens/',
  },
} as unknown as MCPCatalogEntry;

function renderWithConnect(entry: MCPCatalogEntry) {
  const onConnect = vi.fn();
  const props = (
    shown: MCPCatalogEntry,
    open = true,
    credentialRequirement: MCPCatalogCredentialRequirement | null = null,
    identityKey = ALLOWED.userId ?? null
  ) => ({
    identityKey,
    entry: shown,
    open,
    onClose: vi.fn(),
    branches: BRANCHES,
    branchesLoading: false,
    branchesError: null,
    defaultBranchId: 'branch-1',
    connecting: false,
    connectError: null,
    credentialRequirement,
    connectCapability: { ...ALLOWED, userId: identityKey ?? undefined },
    policyPending: false,
    policyPendingHint: POLICY_LOADING_HINT,
    readiness: {
      catalog_key: shown.name,
      state:
        shown.auth_type === 'credentials' ? ('bearer_required' as const) : ('no_auth' as const),
    },
    onConnect,
  });
  const view = render(<CatalogDetailDrawer {...props(entry)} />);
  return {
    onConnect,
    show: (next: MCPCatalogEntry) => view.rerender(<CatalogDetailDrawer {...props(next)} />),
    // The Marketplace keeps this component mounted and toggles `open`, so
    // closing it is a prop change rather than an unmount — which is exactly why
    // state on it outlives the interaction unless something clears it.
    setOpen: (open: boolean) => view.rerender(<CatalogDetailDrawer {...props(entry, open)} />),
    /** What `CatalogTab` does after a refusal that named a requirement. */
    answerFromEndpoint: (requirement: MCPCatalogCredentialRequirement) =>
      view.rerender(<CatalogDetailDrawer {...props(entry, true, requirement)} />),
    replaceIdentity: (identityKey: string) =>
      view.rerender(<CatalogDetailDrawer {...props(entry, true, null, identityKey)} />),
  };
}

const keyField = () => screen.queryByPlaceholderText(/Paste your .* bearer access token/);

describe('CatalogDetailDrawer API key', () => {
  it('uses the catalog PAT terminology instead of calling GitHub credentials API keys', () => {
    renderWithConnect(GITHUB);

    expect(screen.getByText('Use your fine-grained personal access token')).toBeVisible();
    expect(screen.queryByText('Use your API key')).not.toBeInTheDocument();
  });

  it('erases same-entry consent and the pasted key on same-role identity replacement', () => {
    const { onConnect, replaceIdentity } = renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(keyField() as HTMLElement, { target: { value: 'admin-a-private-key' } });
    expect(connectButton()).toBeEnabled();

    replaceIdentity('user-admin-b');

    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(keyField()).toHaveValue('');
    expect(connectButton()).toBeDisabled();
    fireEvent.click(connectButton());
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('offers a key field for an entry that needs one, and gates connect on it', () => {
    renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));

    // Acknowledged, branch chosen — and still not connectable, because the
    // endpoint will refuse an install without a key anyway. Finding that out
    // at the button beats finding it out from the daemon.
    expect(keyField()).toBeVisible();
    expect(screen.getByText('Use your fine-grained personal access token')).toBeVisible();
    expect(screen.queryByText('Use your API key')).not.toBeInTheDocument();
    expect(connectButton()).toBeDisabled();

    fireEvent.change(keyField() as HTMLElement, { target: { value: 'fake-key-1111' } });

    expect(connectButton()).toBeEnabled();
  });

  it('hands the pasted key to the connect callback', () => {
    const { onConnect } = renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(keyField() as HTMLElement, { target: { value: '  fake-key-1111  ' } });

    fireEvent.click(connectButton());

    // Trimmed here as well as on the daemon: a key pasted from a terminal
    // routinely arrives with surrounding whitespace, and the button should not
    // enable for a field holding only spaces.
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-1', bearerToken: 'fake-key-1111' })
    );
  });

  it('does not enable connect for a field holding only whitespace', () => {
    renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));

    fireEvent.change(keyField() as HTMLElement, { target: { value: '   ' } });

    expect(connectButton()).toBeDisabled();
  });

  it('does not carry a key typed for one server to the next one shown', () => {
    // The hazard the field is keyed by entry to prevent: the drawer stays open
    // across a change of entry, so a bare string would leave GitHub's key in
    // the box for a connect to Sentry.
    const { show } = renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(keyField() as HTMLElement, { target: { value: 'fake-github-key' } });

    show(SENTRY);

    expect(keyField()).toHaveValue('');
    expect(connectButton()).toBeDisabled();
  });

  it('does not repopulate the field with a key discarded by closing the drawer', () => {
    // `destroyOnHidden` unmounts the drawer's *contents* — the input and its
    // reveal toggle — but this component stays mounted for as long as the
    // Marketplace is open. Without an explicit discard the pasted key sat in
    // React state indefinitely and came back, revealable, on reopening.
    const { setOpen } = renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(keyField() as HTMLElement, { target: { value: 'fake-github-key' } });

    setOpen(false);
    setOpen(true);

    expect(keyField()).toHaveValue('');
    expect(connectButton()).toBeDisabled();
  });

  it('keeps the key while a failed connect is still on screen', () => {
    // The other half of the rule. A connect that failed leaves the drawer open,
    // and a user who mistyped one character should not have to find the key
    // again to fix it.
    renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(keyField() as HTMLElement, { target: { value: 'fake-github-key' } });

    expect(keyField()).toHaveValue('fake-github-key');
    expect(connectButton()).toBeEnabled();
  });

  it('points at the vendor’s own page for where to get a key', () => {
    // "API key" is ambiguous on a page that also mentions Agor, and without a
    // pointer the answer is a search engine.
    renderWithConnect(GITHUB);

    const link = screen.getByRole('link', { name: /Where to find it/ });
    expect(link).toHaveAttribute('href', GITHUB.credentials?.acquisition_url);
  });

  it('keeps the prescribed bearer field when the endpoint confirms credentials', () => {
    const { answerFromEndpoint } = renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));
    answerFromEndpoint('required');

    expect(keyField()).toBeVisible();
    expect(connectButton()).toBeDisabled();
    fireEvent.change(keyField() as HTMLElement, { target: { value: 'fake-key-1111' } });
    expect(connectButton()).toBeEnabled();
  });

  it('sends the key on the retry the endpoint asked for', () => {
    // The whole point of one extra round trip: the second attempt carries what
    // the first was refused for lacking.
    const { answerFromEndpoint, onConnect } = renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));
    answerFromEndpoint('required');
    fireEvent.change(keyField() as HTMLElement, { target: { value: 'fake-key-1111' } });

    fireEvent.click(connectButton());

    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ bearerToken: 'fake-key-1111' })
    );
  });

  it('drops the requirement when the endpoint says it wants no key', () => {
    // The other direction: the entry says `credentials`, the vendor has opened
    // the endpoint up, and the daemon refuses every keyed request. The button
    // was unreachable because it demanded a key that guaranteed refusal.
    const { answerFromEndpoint } = renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(keyField() as HTMLElement, { target: { value: 'fake-github-key' } });

    answerFromEndpoint('not_accepted');

    expect(keyField()).toBeNull();
    expect(connectButton()).toBeEnabled();
  });

  it('does not send — or keep — a key the endpoint refused to take', () => {
    // Hiding the field while still holding what was typed in it would be the
    // retention bug one state further along, and submitting it would repeat the
    // refusal the retry exists to escape.
    const { answerFromEndpoint, onConnect } = renderWithConnect(GITHUB);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(keyField() as HTMLElement, { target: { value: 'fake-github-key' } });
    answerFromEndpoint('not_accepted');

    fireEvent.click(connectButton());

    expect(onConnect).toHaveBeenCalledWith(
      expect.not.objectContaining({ bearerToken: expect.anything() })
    );
    // And the discarded key is not waiting in the field if the requirement
    // flips back.
    answerFromEndpoint('required');
    expect(keyField()).toHaveValue('');
  });

  it('offers no key field for an entry that does not need one', () => {
    const { onConnect } = renderWithConnect(DEEPWIKI);
    fireEvent.click(screen.getByRole('checkbox'));

    expect(keyField()).toBeNull();

    fireEvent.click(connectButton());

    // No `bearerToken` at all rather than an empty one: the daemon refuses a key
    // sent to an endpoint that never asked for one.
    expect(onConnect).toHaveBeenCalledWith(
      expect.not.objectContaining({ bearerToken: expect.anything() })
    );
  });

  it('still removes the whole form for an entry the marketplace cannot install', () => {
    // `blocked` and `api-key` are different answers. The key field must not
    // resurrect a form for an entry with no endpoint to send anything to.
    renderWithConnect({ ...GITHUB, remote_url: undefined, has_remote: false } as MCPCatalogEntry);

    expect(keyField()).toBeNull();
    expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull();
  });
});
