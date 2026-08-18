import { canConfigureMCPServers } from '@agor/core/mcp/member-policy';
import type { AgorClient, MCPMemberPolicy, MCPServer, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { MCPServersTable } from './MCPServersTable';

const ADMIN: User = {
  user_id: 'user-admin',
  email: 'admin@agor.live',
  name: 'Ada Admin',
  role: 'admin',
} as User;

const MEMBER: User = {
  user_id: 'user-member',
  email: 'bob@agor.live',
  name: 'Bob Member',
  role: 'member',
} as User;

const VIEWER: User = {
  user_id: 'user-viewer',
  email: 'val@agor.live',
  name: 'Val Viewer',
  role: 'viewer',
} as User;

const USER_BY_ID = new Map<string, User>([
  [ADMIN.user_id, ADMIN],
  [MEMBER.user_id, MEMBER],
]);

function makeServer(overrides: Partial<MCPServer>): MCPServer {
  return {
    mcp_server_id: 'server-1',
    name: 'shared-server',
    transport: 'http',
    url: 'https://mcp.example.com',
    scope: 'global',
    source: 'user',
    enabled: true,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as MCPServer;
}

function makeClient(
  policy: MCPMemberPolicy,
  role: string | undefined,
  findError?: Error,
  omitCanConfigure = false,
  findPending = false
) {
  // The daemon answers `can_configure` from the caller's role and the policy
  // together; the fake answers it the same way rather than inventing one, so a
  // test cannot pass against a UI that recomputed the rule differently.
  const setting = omitCanConfigure
    ? ({ policy } as { policy: MCPMemberPolicy; can_configure: boolean })
    : { policy, can_configure: canConfigureMCPServers(role, policy) };
  const find = findPending
    ? // Never settles, so the in-flight state holds still while it is asserted
      // across both panes rather than racing the resolution.
      vi.fn().mockReturnValue(new Promise<never>(() => {}))
    : findError
      ? vi.fn().mockRejectedValue(findError)
      : vi.fn().mockResolvedValue(setting);
  const patch = vi.fn(async (_id: null, data: { policy: MCPMemberPolicy }) =>
    omitCanConfigure
      ? ({ ...data } as { policy: MCPMemberPolicy; can_configure: boolean })
      : { ...data, can_configure: canConfigureMCPServers(role, data.policy) }
  );
  const client = {
    // The create form subscribes to the OAuth browser-flow hint on mount.
    io: { on: vi.fn(), off: vi.fn() },
    service: (path: string) => {
      if (path === 'mcp-member-policy') return { find, patch };
      return {};
    },
  } as unknown as AgorClient;
  return { client, find, patch };
}

function renderTable(options: {
  policy: MCPMemberPolicy;
  currentUser: User;
  servers?: MCPServer[];
  findError?: Error;
  /** Answer without the capability field, as a daemon of another version may. */
  omitCanConfigure?: boolean;
  /** Hold the read in flight, for the state between mount and an answer. */
  findPending?: boolean;
}) {
  const { client, find, patch } = makeClient(
    options.policy,
    options.currentUser.role,
    options.findError,
    options.omitCanConfigure,
    options.findPending
  );
  const mcpServerById = new Map(
    (options.servers ?? []).map((server) => [server.mcp_server_id, server])
  );
  render(
    <AntdApp>
      <MCPServersTable
        mcpServerById={mcpServerById}
        client={client}
        userById={USER_BY_ID}
        currentUser={options.currentUser}
      />
    </AntdApp>
  );
  return { find, patch };
}

// The hints the servers pane gives instead of a policy it has not read. Matched
// on their distinctive wording rather than imported, so a test cannot widen the
// component's surface.
const POLICY_LOADING_HINT = /Checking what this workspace's MCP policy allows/i;
const POLICY_UNREADABLE_HINT = /MCP policy could not be read/i;

const policyRadio = (name: RegExp) => screen.getByRole('radio', { name });

async function openCreateForm(): Promise<void> {
  const addButton = screen.getByRole('button', { name: /New MCP Server/i });
  await waitFor(() => expect(addButton).toBeEnabled());
  fireEvent.click(addButton);
}

/**
 * Switch to the policy pane; the servers are what the tab opens on.
 *
 * A pane is mounted on first visit and kept hidden thereafter, so an assertion
 * that the policy is absent holds only before the reader has been there — it is
 * not yet mounted, rather than torn down on the way out.
 */
const openPolicyPane = () => fireEvent.click(screen.getByRole('tab', { name: 'Member policy' }));

describe('MCPServersTable member policy', () => {
  it('opens on the servers, with the policy a pane away', async () => {
    const { find } = renderTable({ policy: 'use_existing_only', currentUser: ADMIN });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    // The table is what the tab is opened for, so nothing about the policy
    // stands between the reader and it.
    expect(screen.getByRole('tab', { name: 'Servers' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByText(/One setting for the whole workspace/i)).not.toBeInTheDocument();
  });

  it('lets an admin read the policy in plain language and change it', async () => {
    const { find, patch } = renderTable({ policy: 'use_existing_only', currentUser: ADMIN });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    openPolicyPane();

    expect(screen.getByText(/One setting for the whole workspace, not per user/i)).toBeVisible();
    const inForce = policyRadio(/Use existing servers only/);
    expect(inForce).toBeChecked();
    expect(inForce).toBeEnabled();
    expect(
      screen.getByText(/Members can use the MCP servers an admin has already configured/i)
    ).toBeVisible();

    fireEvent.click(policyRadio(/Members can add shared servers/));

    await waitFor(() => expect(patch).toHaveBeenCalledWith(null, { policy: 'allow_crud' }));
    // The pane follows the value it was changed to, not the one it opened on.
    await waitFor(() => expect(policyRadio(/Members can add shared servers/)).toBeChecked());
    expect(policyRadio(/Use existing servers only/)).not.toBeChecked();
  });

  it('shows a member the policy read-only, with the reason adding is refused', async () => {
    const { find, patch } = renderTable({ policy: 'use_existing_only', currentUser: MEMBER });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeDisabled();

    // The pane is not admin-gated: the reader who is refused is the one who
    // needs it. It states the choice rather than rendering one they lack.
    openPolicyPane();

    expect(screen.getByText(/Use existing servers only/)).toBeVisible();
    expect(screen.getByText(/Only an admin can change it/i)).toBeVisible();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it('offers a member the add action once the policy allows it', async () => {
    const { find } = renderTable({ policy: 'allow_private_only', currentUser: MEMBER });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeEnabled();
  });

  it('withholds the add action, without naming a policy, until the policy is known', async () => {
    // The read is held in flight: this is the state between mount and an answer.
    renderTable({ policy: 'allow_crud', currentUser: MEMBER, findPending: true });

    const add = screen.getByRole('button', { name: /New MCP Server/i });
    expect(add).toBeDisabled();

    // The reason has to be read from the tooltip: its content is rendered on
    // hover, so asserting the absent phrase alone would prove nothing.
    fireEvent.mouseOver(add);

    expect(await screen.findByText(POLICY_LOADING_HINT)).toBeInTheDocument();
    expect(screen.queryByText(/does not let you add MCP servers/i)).not.toBeInTheDocument();

    // The pane must not name the restrictive value it is falling back to either.
    openPolicyPane();

    expect(screen.queryByText(/Members can add shared servers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Use existing servers only/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Only an admin can change it/i)).not.toBeInTheDocument();
  });

  it('offers a member only the transports the daemon accepts from them', async () => {
    const { find } = renderTable({ policy: 'allow_crud', currentUser: MEMBER });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    await openCreateForm();

    // stdio runs a command on the executor host, so it is admin-only: a member
    // must not be handed a form pre-filled towards a refusal. The form follows
    // the selected transport, so a URL field and no command field is the
    // rendered proof that it did not default to stdio.
    expect(await screen.findByLabelText('URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
  });

  it('offers a member no workspace-wide scope under allow_private_only', async () => {
    const { find } = renderTable({ policy: 'allow_private_only', currentUser: MEMBER });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    await openCreateForm();

    // The endpoint refuses a member's `global` row under this policy, so the
    // form must not invite one.
    fireEvent.mouseDown(await screen.findByLabelText('Scope'));

    // Selected and offered both render the label, so one match is the floor.
    await waitFor(() => expect(screen.getAllByText('Session').length).toBeGreaterThan(0));
    expect(screen.queryByText('Global (all sessions)')).not.toBeInTheDocument();
  });

  it('offers an admin workspace-wide scope', async () => {
    const { find } = renderTable({ policy: 'allow_private_only', currentUser: ADMIN });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    await openCreateForm();

    const scope = await screen.findByLabelText('Scope');
    fireEvent.mouseDown(scope);
    expect(await screen.findByText('Global (all sessions)')).toBeInTheDocument();
  });

  it('offers an admin every transport', async () => {
    const { find } = renderTable({ policy: 'use_existing_only', currentUser: ADMIN });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    await openCreateForm();

    expect(await screen.findByLabelText('Command')).toBeInTheDocument();
  });

  it('states no policy at all when the policy could not be read', async () => {
    const { find } = renderTable({
      policy: 'allow_crud',
      currentUser: MEMBER,
      findError: new Error('Network request failed'),
    });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    // The workspace may well allow adding; the daemon was simply unreachable.
    const add = screen.getByRole('button', { name: /New MCP Server/i });
    expect(add).toBeDisabled();

    fireEvent.mouseOver(add);

    expect(await screen.findByText(POLICY_UNREADABLE_HINT)).toBeInTheDocument();
    expect(screen.queryByText(/does not let you add MCP servers/i)).not.toBeInTheDocument();

    openPolicyPane();

    // The failure is what the pane has to report — the restrictive value the UI
    // falls back to meanwhile is not a policy to state.
    expect(screen.getByText('Network request failed')).toBeInTheDocument();
    expect(screen.queryByText(/Use existing servers only/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Only an admin can change it/i)).not.toBeInTheDocument();
  });

  it('withholds from an admin whose policy read failed, and names no value', async () => {
    // Distinct from an answer that arrived without `can_configure`: nothing
    // arrived, so the admin clause has nothing to stand on either.
    renderTable({
      policy: 'allow_crud',
      currentUser: ADMIN,
      findError: new Error('Network request failed'),
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeDisabled()
    );

    openPolicyPane();

    // The options render; none of them is presented as the one in force.
    expect(screen.getByText('Network request failed')).toBeInTheDocument();
    expect(policyRadio(/Members can add shared servers/)).not.toBeChecked();
    expect(policyRadio(/Use existing servers only/)).not.toBeChecked();
  });

  it('holds the edit form to the transports a member may switch to', async () => {
    const { find } = renderTable({
      policy: 'allow_private_only',
      currentUser: MEMBER,
      servers: [
        makeServer({
          mcp_server_id: 'mine',
          name: 'my-server',
          owner_user_id: MEMBER.user_id as MCPServer['owner_user_id'],
        }),
      ],
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    const [, edit] = Array.from(rowFor('my-server').querySelectorAll('button'));
    fireEvent.click(edit as HTMLButtonElement);

    // Switching an editable server to stdio is the same refusal the create form
    // avoids, so the editor must not offer it either.
    expect(await screen.findByLabelText('URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
  });

  it('offers an admin the add action under the policy that withholds it from members', async () => {
    // The daemon answers `can_configure` for the caller, so this is the wiring
    // check that the UI asks it rather than reading the policy value alone.
    const { find } = renderTable({ policy: 'use_existing_only', currentUser: ADMIN });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeEnabled();
  });

  it('leaves an admin working against an answer that carries no capability', async () => {
    const { find } = renderTable({
      policy: 'allow_crud',
      currentUser: ADMIN,
      omitCanConfigure: true,
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    // An admin may configure under every policy value, so a missing field must
    // not leave them disabled behind a reason that is not about them.
    expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeEnabled();
  });

  it('withholds from a member when the answer carries no capability', async () => {
    const { find } = renderTable({
      policy: 'allow_crud',
      currentUser: MEMBER,
      omitCanConfigure: true,
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeDisabled();
  });

  it('withholds every action from a read-only account, whatever the policy allows', async () => {
    const { find } = renderTable({
      policy: 'allow_crud',
      currentUser: VIEWER,
      servers: [makeServer({ mcp_server_id: 'shared', name: 'workspace-server' })],
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    // Queried through the DOM rather than by role: Ant Design's table styles
    // defeat jsdom's CSS parser, which an accessibility query would run.
    const add = screen.getByText('New MCP Server').closest('button') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    // View stays; edit and delete do not.
    const actions = Array.from(rowFor('workspace-server').querySelectorAll('button'));
    expect(actions.map((button) => button.disabled)).toEqual([false, true, true]);
  });

  it('tells a read-only account about its role, not about the workspace policy', async () => {
    const { find } = renderTable({ policy: 'allow_crud', currentUser: VIEWER });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    fireEvent.mouseOver(screen.getByRole('button', { name: /New MCP Server/i }));

    // Naming the policy would be a false lead: changing it would not help.
    expect(await screen.findByText(/read-only access/i)).toBeInTheDocument();
    expect(screen.queryByText(/does not let you add MCP servers/i)).not.toBeInTheDocument();
  });

  it('reads the policy once, not once per server row', async () => {
    const { find } = renderTable({
      policy: 'allow_crud',
      currentUser: ADMIN,
      servers: [
        makeServer({ mcp_server_id: 'server-1', name: 'alpha' }),
        makeServer({ mcp_server_id: 'server-2', name: 'beta' }),
        makeServer({ mcp_server_id: 'server-3', name: 'gamma' }),
      ],
    });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    expect(find).toHaveBeenCalledTimes(1);
  });
});

// Ant Design's table styles defeat jsdom's CSS parser, so rows are asserted on
// presence and attributes rather than through computed visibility.
const rowFor = (cellText: string): HTMLElement => {
  // The name column prints the display name and the slug, so match the first.
  const row = screen.getAllByText(cellText)[0]?.closest('tr');
  if (!row) throw new Error(`No table row rendered for "${cellText}"`);
  return row as HTMLElement;
};

describe('MCPServersTable ownership', () => {
  it('renders an unowned server as shared with the workspace rather than blank', async () => {
    const { find } = renderTable({
      policy: 'use_existing_only',
      currentUser: ADMIN,
      servers: [makeServer({ owner_user_id: undefined })],
    });

    await waitFor(() => expect(find).toHaveBeenCalled());

    expect(screen.getByText('Shared with workspace')).toBeInTheDocument();
  });

  it('names the owner of a private server', async () => {
    const { find } = renderTable({
      policy: 'allow_private_only',
      currentUser: ADMIN,
      servers: [makeServer({ owner_user_id: MEMBER.user_id as MCPServer['owner_user_id'] })],
    });

    await waitFor(() => expect(find).toHaveBeenCalled());

    expect(screen.getByText('Bob Member')).toBeInTheDocument();
    expect(screen.queryByText('Shared with workspace')).not.toBeInTheDocument();
  });

  it('marks the signed-in member as the owner of their own server', async () => {
    const { find } = renderTable({
      policy: 'allow_private_only',
      currentUser: MEMBER,
      servers: [makeServer({ owner_user_id: MEMBER.user_id as MCPServer['owner_user_id'] })],
    });

    await waitFor(() => expect(find).toHaveBeenCalled());

    expect(screen.getByText('Bob Member (you)')).toBeInTheDocument();
  });

  it('leaves a member the actions on their own server and withholds the rest', async () => {
    const { find } = renderTable({
      policy: 'allow_private_only',
      currentUser: MEMBER,
      servers: [
        makeServer({
          mcp_server_id: 'mine',
          name: 'my-server',
          owner_user_id: MEMBER.user_id as MCPServer['owner_user_id'],
        }),
        makeServer({ mcp_server_id: 'shared', name: 'workspace-server' }),
      ],
    });

    await waitFor(() => expect(find).toHaveBeenCalled());

    // Each row renders view, edit and delete in that order. Under
    // `allow_private_only` a member manages their own server and only reads
    // the workspace's.
    const own = Array.from(rowFor('my-server').querySelectorAll('button'));
    const shared = Array.from(rowFor('workspace-server').querySelectorAll('button'));

    expect(own.map((button) => button.disabled)).toEqual([false, false, false]);
    expect(shared.map((button) => button.disabled)).toEqual([false, true, true]);
  });
});
