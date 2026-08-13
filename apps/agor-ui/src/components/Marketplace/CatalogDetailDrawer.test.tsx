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

import type { Branch, MCPCatalogEntry, MCPCatalogEntryID } from '@agor/core/types';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CatalogDetailDrawer } from './CatalogDetailDrawer';

const DEEPWIKI = {
  catalog_entry_id: 'entry-deepwiki' as MCPCatalogEntryID,
  created_at: new Date(0),
  updated_at: new Date(0),
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  benefit: 'Ask questions about any public GitHub repository.',
  permission_disclosure: 'Reads public GitHub repository content only.',
  capabilities: ['docs'],
  has_remote: true,
  has_package: false,
  curated: true,
  verified: false,
  remote_url: 'https://mcp.deepwiki.com/mcp',
  transport: 'streamable-http',
  probed_auth_type: 'none',
} as unknown as MCPCatalogEntry;

const LINEAR = {
  ...DEEPWIKI,
  catalog_entry_id: 'entry-linear' as MCPCatalogEntryID,
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
