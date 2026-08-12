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

function makeClient(policy: MCPMemberPolicy, findError?: Error) {
  const find = findError
    ? vi.fn().mockRejectedValue(findError)
    : vi.fn().mockResolvedValue({ policy });
  const patch = vi.fn(async (_id: null, data: { policy: MCPMemberPolicy }) => data);
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
}) {
  const { client, find, patch } = makeClient(options.policy, options.findError);
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

const policyRadio = (name: RegExp) => screen.getByRole('radio', { name });

describe('MCPServersTable member policy', () => {
  it('lets an admin read the policy in plain language and change it', async () => {
    const { find, patch } = renderTable({ policy: 'use_existing_only', currentUser: ADMIN });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    expect(screen.getByText(/One setting for the whole workspace, not per user/i)).toBeVisible();
    const inForce = policyRadio(/Use existing servers only/);
    expect(inForce).toBeChecked();
    expect(inForce).toBeEnabled();
    expect(
      screen.getByText(/Members can use the MCP servers an admin has already configured/i)
    ).toBeVisible();

    fireEvent.click(policyRadio(/Members can add shared servers/));

    await waitFor(() => expect(patch).toHaveBeenCalledWith(null, { policy: 'allow_crud' }));
  });

  it('shows a member the policy read-only, with the reason adding is refused', async () => {
    const { find, patch } = renderTable({ policy: 'use_existing_only', currentUser: MEMBER });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    expect(policyRadio(/Use existing servers only/)).toBeDisabled();
    expect(policyRadio(/Members can add shared servers/)).toBeDisabled();
    expect(screen.getByText(/Only an admin can change it/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeDisabled();

    fireEvent.click(policyRadio(/Members can add shared servers/));
    expect(patch).not.toHaveBeenCalled();
  });

  it('offers a member the add action once the policy allows it', async () => {
    const { find } = renderTable({ policy: 'allow_private_only', currentUser: MEMBER });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeEnabled();
  });

  it('withholds the add action, without naming a policy, until the policy is known', () => {
    // No `await`: this is the state between mount and the fetch resolving.
    renderTable({ policy: 'allow_crud', currentUser: MEMBER });

    expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeDisabled();
    expect(screen.queryByText(/does not let you add MCP servers/i)).not.toBeInTheDocument();
  });

  it('offers a member only the transports the daemon accepts from them', async () => {
    const { find } = renderTable({ policy: 'allow_crud', currentUser: MEMBER });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /New MCP Server/i }));

    // stdio runs a command on the executor host, so it is admin-only: a member
    // must not be handed a form pre-filled towards a refusal. The form follows
    // the selected transport, so a URL field and no command field is the
    // rendered proof that it did not default to stdio.
    expect(await screen.findByLabelText('URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
  });

  it('offers an admin every transport', async () => {
    const { find } = renderTable({ policy: 'use_existing_only', currentUser: ADMIN });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /New MCP Server/i }));

    expect(await screen.findByLabelText('Command')).toBeInTheDocument();
  });

  it('states no policy at all when the policy could not be read', async () => {
    renderTable({
      policy: 'allow_crud',
      currentUser: MEMBER,
      findError: new Error('Network request failed'),
    });

    await waitFor(() => expect(screen.getByText('Network request failed')).toBeInTheDocument());

    // The workspace may well allow adding; the daemon was simply unreachable.
    expect(screen.getByRole('button', { name: /New MCP Server/i })).toBeDisabled();
    expect(screen.queryByText(/does not let you add MCP servers/i)).not.toBeInTheDocument();
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
