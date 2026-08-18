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

import type { Branch, MCPCatalogEntry } from '@agor/core/types';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CatalogDetailDrawer } from './CatalogDetailDrawer';

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

const BRANCHES = [{ branch_id: 'branch-1', name: 'mkt-slice' }] as unknown as Branch[];

function renderDrawer(entry: MCPCatalogEntry) {
  const view = render(
    <CatalogDetailDrawer
      entry={entry}
      open
      onClose={vi.fn()}
      branches={BRANCHES}
      branchesLoading={false}
      branchesError={null}
      defaultBranchId="branch-1"
      connecting={false}
      connectError={null}
      onConnect={vi.fn()}
    />
  );
  const show = (next: MCPCatalogEntry) =>
    view.rerender(
      <CatalogDetailDrawer
        entry={next}
        open
        onClose={vi.fn()}
        branches={BRANCHES}
        branchesLoading={false}
        branchesError={null}
        defaultBranchId="branch-1"
        connecting={false}
        connectError={null}
        onConnect={vi.fn()}
      />
    );
  return { show };
}

const connectButton = () => screen.getByRole('button', { name: /Connect/ });

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
const DATADOG = {
  ...DEEPWIKI,
  name: 'com.datadoghq/mcp',
  title: 'Datadog',
  permission_disclosure: 'Reads metrics, logs, traces, monitors, and incidents.',
  website_url: 'https://docs.datadoghq.com/account_management/api-app-keys/',
  auth_type: 'credentials',
} as unknown as MCPCatalogEntry;

const SENTRY = {
  ...DATADOG,
  name: 'io.sentry/mcp',
  title: 'Sentry',
  permission_disclosure: 'Reads issues and events from the Sentry organisations you authorise.',
} as unknown as MCPCatalogEntry;

function renderWithConnect(entry: MCPCatalogEntry) {
  const onConnect = vi.fn();
  const props = (shown: MCPCatalogEntry) => ({
    entry: shown,
    open: true,
    onClose: vi.fn(),
    branches: BRANCHES,
    branchesLoading: false,
    branchesError: null,
    defaultBranchId: 'branch-1',
    connecting: false,
    connectError: null,
    onConnect,
  });
  const view = render(<CatalogDetailDrawer {...props(entry)} />);
  return {
    onConnect,
    show: (next: MCPCatalogEntry) => view.rerender(<CatalogDetailDrawer {...props(next)} />),
  };
}

const keyField = () => screen.queryByPlaceholderText(/Paste your .* API key/);

describe('CatalogDetailDrawer API key', () => {
  it('offers a key field for an entry that needs one, and gates connect on it', () => {
    renderWithConnect(DATADOG);
    fireEvent.click(screen.getByRole('checkbox'));

    // Acknowledged, branch chosen — and still not connectable, because the
    // endpoint will refuse an install without a key anyway. Finding that out
    // at the button beats finding it out from the daemon.
    expect(keyField()).toBeVisible();
    expect(connectButton()).toBeDisabled();

    fireEvent.change(keyField() as HTMLElement, { target: { value: 'fake-key-1111' } });

    expect(connectButton()).toBeEnabled();
  });

  it('hands the pasted key to the connect callback', () => {
    const { onConnect } = renderWithConnect(DATADOG);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(keyField() as HTMLElement, { target: { value: '  fake-key-1111  ' } });

    fireEvent.click(connectButton());

    // Trimmed here as well as on the daemon: a key pasted from a terminal
    // routinely arrives with surrounding whitespace, and the button should not
    // enable for a field holding only spaces.
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-1', apiKey: 'fake-key-1111' })
    );
  });

  it('does not enable connect for a field holding only whitespace', () => {
    renderWithConnect(DATADOG);
    fireEvent.click(screen.getByRole('checkbox'));

    fireEvent.change(keyField() as HTMLElement, { target: { value: '   ' } });

    expect(connectButton()).toBeDisabled();
  });

  it('does not carry a key typed for one server to the next one shown', () => {
    // The hazard the field is keyed by entry to prevent: the drawer stays open
    // across a change of entry, so a bare string would leave Datadog's key in
    // the box for a connect to Sentry.
    const { show } = renderWithConnect(DATADOG);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(keyField() as HTMLElement, { target: { value: 'fake-datadog-key' } });

    show(SENTRY);

    expect(keyField()).toHaveValue('');
    expect(connectButton()).toBeDisabled();
  });

  it('points at the vendor’s own page for where to get a key', () => {
    // "API key" is ambiguous on a page that also mentions Agor, and without a
    // pointer the answer is a search engine.
    renderWithConnect(DATADOG);

    const link = screen.getByRole('link', { name: /Where to find it/ });
    expect(link).toHaveAttribute('href', DATADOG.website_url);
  });

  it('offers no key field for an entry that does not need one', () => {
    const { onConnect } = renderWithConnect(DEEPWIKI);
    fireEvent.click(screen.getByRole('checkbox'));

    expect(keyField()).toBeNull();

    fireEvent.click(connectButton());

    // No `apiKey` at all rather than an empty one: the daemon refuses a key
    // sent to an endpoint that never asked for one.
    expect(onConnect).toHaveBeenCalledWith(
      expect.not.objectContaining({ apiKey: expect.anything() })
    );
  });

  it('still removes the whole form for an entry the marketplace cannot install', () => {
    // `blocked` and `api-key` are different answers. The key field must not
    // resurrect a form for an entry with no endpoint to send anything to.
    renderWithConnect({ ...DATADOG, remote_url: undefined, has_remote: false } as MCPCatalogEntry);

    expect(keyField()).toBeNull();
    expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull();
  });
});
