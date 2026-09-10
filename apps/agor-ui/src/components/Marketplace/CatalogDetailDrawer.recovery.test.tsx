import type { Branch, MCPCatalogEntry } from '@agor/core/types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MCPServerCapabilityContext, POLICY_LOADING_HINT } from '../MCPServer/memberPolicy';
import { CatalogDetailDrawer } from './CatalogDetailDrawer';

const ALLOWED: MCPServerCapabilityContext = {
  connectionReady: true,
  role: 'admin',
  isAdmin: true,
  policy: 'allow_crud',
  userId: 'user-admin',
  canConfigure: true,
};

const ENTRY: MCPCatalogEntry = {
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  category: 'dev-tools',
  benefit: 'Ask questions about any public GitHub repository.',
  permission_disclosure: 'Reads public GitHub repository content only.',
  starter_prompt: 'Explain this repository.',
  capabilities: ['docs'],
  has_remote: true,
  remote_url: 'https://mcp.deepwiki.com/mcp',
  transport: 'streamable-http',
  auth_type: 'none',
};

const TEAMMATES = [
  {
    branch_id: '019fd25a-7065-75f8-b6e6-f1963f981700',
    name: 'ada-branch',
    custom_context: { teammate: { kind: 'teammate', displayName: 'Ada' } },
  },
] as unknown as Branch[];

function renderDrawer(overrides: Partial<ComponentProps<typeof CatalogDetailDrawer>> = {}) {
  const onConnect = vi.fn();
  const onStartSession = vi.fn();
  render(
    <CatalogDetailDrawer
      identityKey="user-admin"
      entry={ENTRY}
      open
      onClose={vi.fn()}
      teammates={TEAMMATES}
      teammatesLoading={false}
      teammatesError={null}
      defaultTeammateId={TEAMMATES[0].branch_id}
      connecting={false}
      startingSession={false}
      startSessionError={null}
      connectError={null}
      connectCapability={ALLOWED}
      policyPending={false}
      policyPendingHint={POLICY_LOADING_HINT}
      readiness={{ catalog_key: ENTRY.name, state: 'no_auth' }}
      onConnect={onConnect}
      onStartSession={onStartSession}
      {...overrides}
    />
  );
  return { onConnect, onStartSession };
}

afterEach(cleanup);

describe('CatalogDetailDrawer staged flow', () => {
  it('adds a server without asking for a branch, teammate, or agent tool', () => {
    const { onConnect } = renderDrawer();

    expect(screen.queryByText('Branch')).not.toBeInTheDocument();
    expect(screen.queryByText('Teammate')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent tool')).not.toBeInTheDocument();

    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const addButton = screen.getByText('Connect').closest('button');
    if (!checkbox || !addButton) throw new Error('add controls not found');
    fireEvent.click(checkbox);
    fireEvent.click(addButton);

    expect(onConnect).toHaveBeenCalledWith({
      acknowledgedDisclosure: ENTRY.permission_disclosure,
    });
  });

  it('renders a calm next-step state and asks for teammate/tool only on request', async () => {
    const onBeginSessionSetup = vi.fn();
    const { onStartSession } = renderDrawer({
      success: {
        catalogKey: ENTRY.name,
        serverId: 'server-1',
        starterPrompt: ENTRY.starter_prompt,
        authentication: 'ready',
        reusedExistingServer: false,
      },
      onBeginSessionSetup,
      onKeepBrowsing: vi.fn(),
    });

    expect(screen.getByText('Added to My Servers')).toBeInTheDocument();
    expect(screen.queryByText('Starter prompt suggestion')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /insert|copy|dismiss/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Teammate')).not.toBeInTheDocument();

    const beginButton = screen.getByText('Start new session').closest('button');
    if (!beginButton) throw new Error('start-session setup button not found');
    fireEvent.click(beginButton);
    expect(onBeginSessionSetup).toHaveBeenCalledOnce();
    expect(await screen.findByText('Teammate')).toBeInTheDocument();
    expect(screen.getByText('Agent tool')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());

    const startButton = screen.getByText('Start session').closest('button');
    if (!startButton) throw new Error('start-session button not found');
    fireEvent.click(startButton);
    expect(onStartSession).toHaveBeenCalledWith({
      teammateBranchId: TEAMMATES[0].branch_id,
      agenticTool: 'claude-code',
    });
  });

  it('keeps the responsive drawer width contract', () => {
    renderDrawer();
    expect(document.querySelector('.ant-drawer-content-wrapper')).toHaveStyle({ width: '520px' });
  });
});
