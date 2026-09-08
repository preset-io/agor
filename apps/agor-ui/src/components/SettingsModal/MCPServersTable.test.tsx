import { canConfigureMCPServers } from '@agor/core/mcp/member-policy';
import type { AgorClient, MCPMemberPolicy, MCPServer, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import { MCPServersTable } from './MCPServersTable';

const ADMIN: User = {
  user_id: 'user-admin',
  email: 'admin@agor.live',
  name: 'Ada Admin',
  role: 'admin',
} as User;

const ADMIN_B: User = {
  user_id: 'user-admin-b',
  email: 'admin-b@agor.live',
  name: 'Bea Admin',
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
  [ADMIN_B.user_id, ADMIN_B],
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
      if (path === 'mcp-servers') return { on: vi.fn(), removeListener: vi.fn() };
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
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 1,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <MCPServersTable
          mcpServerById={mcpServerById}
          client={client}
          userById={USER_BY_ID}
          currentUser={options.currentUser}
        />
      </ConnectionProvider>
    </AntdApp>
  );
  return { find, patch };
}

// The hints the servers pane gives instead of a policy it has not read. Matched
// on their distinctive wording rather than imported, so a test cannot widen the
// component's surface.
const POLICY_LOADING_HINT = /Checking what this workspace's MCP policy allows/i;
const POLICY_UNREADABLE_HINT = /MCP policy could not be read/i;

// These remain state/event assertions rather than elapsed-time assertions, but
// a cold antd Form/Select mount makes jsdom parse a large generated stylesheet.
// The focused file completes in ~90 seconds; under the full 240-file UI run,
// worker contention can make an individual cold mount exceed the global 15s
// limit without changing the result. Keep the allowance local to these real
// form integration suites rather than weakening the workspace-wide timeout.
const ANT_FORM_INTEGRATION_TIMEOUT = 60_000;
const AUTHORITY_TRANSITION_TIMEOUT = 120_000;

beforeEach(() => {
  agorStore.getState().reset();
});

const policyRadio = (name: RegExp) => screen.getByRole('radio', { name });

async function openCreateForm(): Promise<void> {
  const addButton = screen.getByRole('button', { name: /New MCP Server/i });
  await waitFor(() => expect(addButton).toBeEnabled());
  fireEvent.click(addButton);
  await screen.findByRole('dialog', { name: 'Add MCP Server' });
}

/**
 * Switch to the policy pane; the servers are what the tab opens on.
 *
 * A pane is mounted on first visit and kept hidden thereafter, so an assertion
 * that the policy is absent holds only before the reader has been there — it is
 * not yet mounted, rather than torn down on the way out.
 */
const openPolicyPane = () => fireEvent.click(screen.getByRole('tab', { name: 'Member policy' }));

describe('MCPServersTable member policy', { timeout: ANT_FORM_INTEGRATION_TIMEOUT }, () => {
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

function renderTransitionTable(initial: {
  currentUser: User;
  policy: MCPMemberPolicy;
  servers?: MCPServer[];
  onCreate?: (
    data: Parameters<NonNullable<React.ComponentProps<typeof MCPServersTable>['onCreate']>>[0],
    shouldApply?: () => boolean
  ) => void | Promise<void>;
}) {
  let policy = initial.policy;
  let role = initial.currentUser.role;
  const policyListeners: Array<() => void> = [];
  const find = vi.fn(async () => ({
    policy,
    can_configure: canConfigureMCPServers(role, policy),
  }));
  const serverCreate = vi.fn();
  const serverPatch = vi.fn();
  const mcpServersService = {
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'member-policy:changed') policyListeners.push(listener);
    }),
    removeListener: vi.fn(),
    create: serverCreate,
    patch: serverPatch,
  };
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: (path: string) => {
      if (path === 'mcp-member-policy') return { find, patch: vi.fn() };
      if (path === 'mcp-servers') return mcpServersService;
      return { create: vi.fn() };
    },
  } as unknown as AgorClient;
  const onCreate = vi.fn(initial.onCreate ?? (() => undefined));
  let servers = new Map((initial.servers ?? []).map((server) => [server.mcp_server_id, server]));

  const view = (currentUser: User, connected: boolean, connecting: boolean, generation: number) => (
    <AntdApp>
      <ConnectionProvider
        value={{
          connected,
          connecting,
          authGeneration: generation,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <MCPServersTable
          mcpServerById={servers}
          client={client}
          userById={USER_BY_ID}
          currentUser={currentUser}
          onCreate={onCreate}
        />
      </ConnectionProvider>
    </AntdApp>
  );
  const rendered = render(view(initial.currentUser, true, false, 1));

  return {
    find,
    onCreate,
    serverCreate,
    serverPatch,
    disconnect: () => rendered.rerender(view(initial.currentUser, false, true, 1)),
    replaceRole: (currentUser: User, generation = 2) => {
      role = currentUser.role;
      rendered.rerender(
        view(
          { ...currentUser, user_id: initial.currentUser.user_id } as User,
          true,
          false,
          generation
        )
      );
    },
    replaceIdentity: (currentUser: User, nextServers: MCPServer[] = [], generation = 2) => {
      role = currentUser.role;
      servers = new Map(nextServers.map((server) => [server.mcp_server_id, server]));
      rendered.rerender(view(currentUser, true, false, generation));
    },
    setServers: (nextServers: MCPServer[]) => {
      servers = new Map(nextServers.map((server) => [server.mcp_server_id, server]));
      rendered.rerender(view(initial.currentUser, true, false, 1));
    },
    setPolicy: async (next: MCPMemberPolicy) => {
      policy = next;
      await act(async () => {
        for (const listener of policyListeners) listener();
      });
    },
  };
}

async function fillCreateRequirements(): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Name (Internal ID)'), {
    target: { value: 'transition-server' },
  });
  const command = screen.queryByLabelText('Command');
  if (command) {
    fireEvent.change(command, { target: { value: 'npx transition-server' } });
  } else {
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://transition.example/mcp' },
    });
  }
}

async function chooseSelect(label: string, option: string): Promise<void> {
  const select = screen.getByLabelText(label);
  fireEvent.mouseDown(select);
  const optionContent = await screen.findByText(option, {
    selector: '.ant-select-item-option-content',
  });
  fireEvent.click(optionContent);
}

describe('MCPServersTable transport form state', { timeout: ANT_FORM_INTEGRATION_TIMEOUT }, () => {
  it('does not submit preserved remote fields after switching the create form to stdio', async () => {
    const seam = renderTransitionTable({ currentUser: ADMIN, policy: 'allow_crud' });
    await waitFor(() => expect(seam.find).toHaveBeenCalledTimes(1));
    await openCreateForm();

    fireEvent.change(screen.getByLabelText('Name (Internal ID)'), {
      target: { value: 'transport-switch-server' },
    });
    await chooseSelect('Transport', 'HTTP');
    fireEvent.change(await screen.findByLabelText('URL'), {
      target: { value: 'https://stale-remote.example/mcp' },
    });
    await chooseSelect('Auth Type', 'Bearer Token');
    fireEvent.change(await screen.findByLabelText('Token'), {
      target: { value: 'stale-remote-token' },
    });
    fireEvent.click(screen.getByText('Advanced Configuration'));
    fireEvent.change(await screen.findByLabelText('Custom HTTP Headers'), {
      target: { value: '{"X-Stale":"remote"}' },
    });

    await chooseSelect('Transport', 'stdio (Local process)');
    fireEvent.change(await screen.findByLabelText('Command'), {
      target: { value: 'mcp-server-shortcut' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(seam.onCreate).toHaveBeenCalledOnce());
    const submitted = seam.onCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submitted).toMatchObject({
      name: 'transport-switch-server',
      transport: 'stdio',
      command: 'mcp-server-shortcut',
      args: [],
    });
    expect(submitted).not.toHaveProperty('url');
    expect(submitted).not.toHaveProperty('headers');
    expect(submitted).not.toHaveProperty('auth');
  });
});

describe('MCPServersTable open-dialog authority transitions', {
  timeout: AUTHORITY_TRANSITION_TIMEOUT,
}, () => {
  it('destroys an admin-A create form and raw credential before admin B can use it', async () => {
    const seam = renderTransitionTable({ currentUser: ADMIN, policy: 'allow_crud' });
    await waitFor(() => expect(seam.find).toHaveBeenCalledTimes(1));
    await openCreateForm();
    fireEvent.change(screen.getByLabelText('Name (Internal ID)'), {
      target: { value: 'admin-a-private-server' },
    });
    await chooseSelect('Transport', 'HTTP');
    fireEvent.change(await screen.findByLabelText('URL'), {
      target: { value: 'https://admin-a.example/mcp' },
    });
    await chooseSelect('Auth Type', 'Bearer Token');
    fireEvent.change(await screen.findByLabelText('Token'), {
      target: { value: 'admin-a-raw-bearer-token' },
    });
    const staleCreate = screen.getByRole('button', { name: 'Create' });
    await waitFor(() => expect(staleCreate).toBeEnabled());

    // Validation settles asynchronously. Replace the principal in the same
    // turn so this proves the old continuation cannot submit A's secret as B.
    fireEvent.click(staleCreate);
    seam.replaceIdentity(ADMIN_B);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add MCP Server' })).not.toBeInTheDocument()
    );
    expect(seam.onCreate).not.toHaveBeenCalled();
    expect(seam.serverCreate).not.toHaveBeenCalled();

    await openCreateForm();
    expect(screen.getByLabelText('Name (Internal ID)')).toHaveValue('');
    await chooseSelect('Transport', 'HTTP');
    await chooseSelect('Auth Type', 'Bearer Token');
    expect(await screen.findByLabelText('Token')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('does not close or continue an A create after its parent save crosses auth generation', async () => {
    let resolveSave!: () => void;
    const save = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    let parentGuard: (() => boolean) | undefined;
    const seam = renderTransitionTable({
      currentUser: ADMIN,
      policy: 'allow_crud',
      onCreate: async (_data, shouldApply) => {
        parentGuard = shouldApply;
        await save;
      },
    });
    await waitFor(() => expect(seam.find).toHaveBeenCalledTimes(1));
    await openCreateForm();
    await fillCreateRequirements();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(seam.onCreate).toHaveBeenCalledOnce());
    expect(parentGuard?.()).toBe(true);

    seam.replaceRole(ADMIN, 2);
    expect(parentGuard?.()).toBe(false);
    await act(async () => {
      resolveSave();
      await save;
    });
    expect(screen.getByRole('dialog', { name: 'Add MCP Server' })).toBeInTheDocument();
  });

  it('closes an admin-A view and erases its unredacted environment on admin B', async () => {
    const privateServer = makeServer({
      name: 'admin-a-private-view',
      display_name: 'Admin A Private View',
      env: { PRIVATE_TOKEN: 'admin-a-env-secret' },
    });
    const replacementServer = makeServer({
      mcp_server_id: 'server-b-view',
      name: 'admin-b-view-server',
      display_name: 'Admin B View Server',
    });
    const seam = renderTransitionTable({
      currentUser: ADMIN,
      policy: 'allow_crud',
      servers: [privateServer],
    });
    await waitFor(() => expect(seam.find).toHaveBeenCalledTimes(1));
    const [view] = Array.from(rowFor('Admin A Private View').querySelectorAll('button'));
    fireEvent.click(view as HTMLButtonElement);
    expect(await screen.findByText(/admin-a-env-secret/)).toBeInTheDocument();

    seam.replaceIdentity(ADMIN_B, [replacementServer]);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'MCP Server Details' })).not.toBeInTheDocument()
    );
    expect(screen.queryByText(/admin-a-env-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText('Admin A Private View')).not.toBeInTheDocument();
    expect(screen.getByText('Admin B View Server')).toBeInTheDocument();
  });

  it('closes admin-A edit state when admin B receives a replacement map', async () => {
    const privateServer = makeServer({
      name: 'admin-a-private',
      display_name: 'Admin A Private',
      auth: { type: 'bearer', token: 'admin-a-bearer-secret' },
    });
    const replacementServer = makeServer({
      mcp_server_id: 'server-b',
      name: 'admin-b-server',
      display_name: 'Admin B Server',
    });
    const seam = renderTransitionTable({
      currentUser: ADMIN,
      policy: 'allow_crud',
      servers: [privateServer],
    });
    await waitFor(() => expect(seam.find).toHaveBeenCalledTimes(1));

    const edit = rowFor('Admin A Private').querySelector(
      'button[title="Edit"]'
    ) as HTMLButtonElement;
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit as HTMLButtonElement);
    const token = await screen.findByLabelText('Token');
    fireEvent.change(token, { target: { value: 'admin-a-edited-bearer-secret' } });
    const staleSave = screen.getByRole('button', { name: 'Save' });

    seam.replaceIdentity(ADMIN_B, [replacementServer]);

    await waitFor(() => expect(screen.queryByText('Edit MCP Server')).not.toBeInTheDocument());
    fireEvent.click(staleSave);
    expect(seam.serverPatch).not.toHaveBeenCalled();
    expect(screen.queryByText('Admin A Private')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('admin-a-edited-bearer-secret')).not.toBeInTheDocument();
    expect(screen.getByText('Admin B Server')).toBeInTheDocument();
  });

  it('closes an editor when realtime replacement removes its selected server', async () => {
    const privateServer = makeServer({ name: 'realtime-private' });
    const seam = renderTransitionTable({
      currentUser: ADMIN,
      policy: 'allow_crud',
      servers: [privateServer],
    });
    await waitFor(() => expect(seam.find).toHaveBeenCalledTimes(1));
    const edit = rowFor('realtime-private').querySelector(
      'button[title="Edit"]'
    ) as HTMLButtonElement;
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit as HTMLButtonElement);
    await screen.findByLabelText('URL');

    seam.setServers([]);

    await waitFor(() => expect(screen.queryByText('Edit MCP Server')).not.toBeInTheDocument());
    expect(screen.queryByText('realtime-private')).not.toBeInTheDocument();
  });

  it('blocks an already-open create dialog immediately on disconnect', async () => {
    const seam = renderTransitionTable({ currentUser: ADMIN, policy: 'allow_crud' });
    await waitFor(() => expect(seam.find).toHaveBeenCalledTimes(1));
    await openCreateForm();
    await fillCreateRequirements();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());

    seam.disconnect();

    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(screen.getByText(/MCP server changes are unavailable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(seam.onCreate).not.toHaveBeenCalled();
    expect(seam.serverCreate).not.toHaveBeenCalled();
  });

  it('blocks an already-open create dialog immediately on demotion', async () => {
    const seam = renderTransitionTable({ currentUser: ADMIN, policy: 'allow_crud' });
    await waitFor(() => expect(seam.find).toHaveBeenCalledTimes(1));
    await openCreateForm();
    await fillCreateRequirements();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());

    seam.replaceRole(VIEWER);

    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(seam.onCreate).not.toHaveBeenCalled();
    expect(seam.serverCreate).not.toHaveBeenCalled();
  });

  it('blocks an already-open member create dialog on a live policy downgrade', async () => {
    const seam = renderTransitionTable({ currentUser: MEMBER, policy: 'allow_crud' });
    await waitFor(() => expect(seam.find).toHaveBeenCalledTimes(1));
    await openCreateForm();
    await fillCreateRequirements();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());

    await seam.setPolicy('use_existing_only');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(seam.onCreate).not.toHaveBeenCalled();
    expect(seam.serverCreate).not.toHaveBeenCalled();
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

/**
 * An install that was created but never authenticated.
 *
 * `usableByUserId` filters on ownership alone, so a marketplace connect the
 * user walked away from is listed here in full — enabled, owned, and otherwise
 * reading as a working server. Health is the column that answers "does this
 * work", so it is the one that has to say so.
 */
describe('MCPServersTable unfinished installs', () => {
  const oauthServer = (overrides: Partial<MCPServer> = {}) =>
    makeServer({
      name: 'linear',
      display_name: 'Linear',
      source: 'catalog',
      auth: { type: 'oauth' },
      ...overrides,
    } as Partial<MCPServer>);

  it('names an unauthenticated OAuth install rather than calling it untested', async () => {
    renderTable({
      policy: 'allow_crud',
      currentUser: ADMIN,
      servers: [oauthServer()],
    });

    expect(await screen.findByText('Not signed in')).toBeVisible();
    // "Not tested" is the reading it would otherwise get, and it says nothing
    // about the thing that actually stops this server working.
    expect(screen.queryByText('Not tested')).not.toBeInTheDocument();
  });

  it('reports health normally once oauth-status confirms authentication', async () => {
    act(() => {
      agorStore.getState().applyMaps((prev) => ({
        ...prev,
        userAuthenticatedMcpServerIds: new Set(['server-1']),
      }));
    });
    renderTable({
      policy: 'allow_crud',
      currentUser: ADMIN,
      servers: [oauthServer()],
    });

    expect(await screen.findByText('Not tested')).toBeVisible();
    expect(screen.queryByText('Not signed in')).not.toBeInTheDocument();
  });

  it('leaves the health of a non-OAuth server alone', async () => {
    renderTable({
      policy: 'allow_crud',
      currentUser: ADMIN,
      servers: [makeServer({ tools: [{ name: 'search' }] } as Partial<MCPServer>)],
    });

    expect(await screen.findByText('1 tools')).toBeVisible();
    expect(screen.queryByText('Not signed in')).not.toBeInTheDocument();
  });
});
