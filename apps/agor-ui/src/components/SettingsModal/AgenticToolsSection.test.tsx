import type { AgorClient, TenantAgenticToolName } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { AgenticToolsSection } from './AgenticToolsSection';

// The presets manager makes its own service calls and is exercised elsewhere;
// stub it so the Presets sub-tab is deterministic and echoes its tool prop.
vi.mock('./AgenticToolPresetsManager', () => ({
  AgenticToolPresetsManager: ({ tool }: { tool: string }) => (
    <div data-testid="presets-manager">presets:{tool}</div>
  ),
}));

type Row = {
  tool: string;
  deployment_available: boolean;
  enabled: boolean;
  resolution_policy: string;
  inline_configuration_allowed: boolean;
  connection: Record<string, { configured: boolean }>;
};

const row = (tool: string, enabled = true, deployment_available = true): Row => ({
  tool,
  deployment_available,
  enabled,
  resolution_policy: 'user_preferred',
  inline_configuration_allowed: true,
  connection: {},
});

const makeClient = (rows: Row[]): AgorClient =>
  ({
    service: () => ({
      find: async () => rows,
      patch: async (_id: string, data: unknown) => ({ ...rows[0], ...(data as object) }),
    }),
  }) as unknown as AgorClient;

const allTools = () =>
  ['claude-code', 'codex', 'gemini', 'copilot', 'cursor', 'opencode'].map((t) => row(t));

const renderTool = (tool: TenantAgenticToolName, rows: Row[] = allTools()) =>
  render(
    <AntdApp>
      <AgenticToolsSection client={makeClient(rows)} tool={tool} />
    </AntdApp>
  );

describe('AgenticToolsSection', () => {
  it('renders exactly one tab strip (the nested tabs anti-pattern is gone)', async () => {
    renderTool('claude-code');

    // Tool selection lives in the modal nav now; the only <Tabs> here is the
    // Authentication/Presets split — so exactly one tablist.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeVisible());
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Authentication' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Presets' })).toBeInTheDocument();
  });

  it('renders the panel for whichever tool prop it is given', async () => {
    const { rerender } = renderTool('gemini');
    expect(await screen.findByRole('heading', { name: 'Gemini' })).toBeInTheDocument();

    // Selecting a different tool in the nav re-renders this panel with a new prop.
    rerender(
      <AntdApp>
        <AgenticToolsSection client={makeClient(allTools())} tool="codex" />
      </AntdApp>
    );
    expect(await screen.findByRole('heading', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Gemini' })).not.toBeInTheDocument();
  });

  it('switches the Authentication/Presets sub-tab', async () => {
    renderTool('claude-code');
    await screen.findByRole('heading', { name: 'Claude Code' });

    // Authentication is the default sub-tab.
    expect(screen.getByText('Credential resolution')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Presets' }));
    expect(await screen.findByText('Allow inline configuration')).toBeInTheDocument();
    expect(screen.getByTestId('presets-manager')).toHaveTextContent('presets:claude-code');
  });

  it('reflects the tool availability state', async () => {
    renderTool('codex', [row('claude-code', true), row('codex', false), row('gemini')]);

    expect(
      await screen.findByText('Installed, but disabled in this workspace')
    ).toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('marks a tool the deployment did not install and hides its config', async () => {
    // deployment_available = false
    renderTool('codex', [row('claude-code'), row('codex', false, false)]);

    expect(await screen.findByText('Not installed by this deployment')).toBeInTheDocument();
    expect(
      screen.getByText('This deployment did not install this agentic tool')
    ).toBeInTheDocument();
    // Config is hidden for an uninstalled tool.
    expect(screen.queryByText('Credential resolution')).not.toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
