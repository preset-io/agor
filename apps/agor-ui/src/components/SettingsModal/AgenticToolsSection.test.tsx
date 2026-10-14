import type {
  AgorClient,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
} from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgenticToolsSection } from './AgenticToolsSection';
import { renderWithSettingsShell } from './settingsDrillTestUtils';

const tools: TenantAgenticToolName[] = [
  'claude-code',
  'codex',
  'gemini',
  'copilot',
  'cursor',
  'opencode',
];

describe('AgenticToolsSection deployment availability', () => {
  it('distinguishes an uninstalled deployment package without offering a mutation action', async () => {
    const settings: TenantAgenticToolSettings[] = tools.map((tool) => ({
      tool,
      deployment_available: tool !== 'claude-code',
      enabled: false,
      resolution_policy: 'user_preferred',
      inline_configuration_allowed: true,
      connection: {},
    }));
    const client = {
      service: vi.fn(() => ({ find: vi.fn().mockResolvedValue(settings) })),
    } as unknown as AgorClient;

    render(
      <AgenticToolsSection
        client={client}
        identityKey="admin-a:admin"
        operationScope={['admin-a:admin', client, 1]}
      />
    );

    expect(await screen.findByText('Not installed by this deployment')).toBeInTheDocument();
    expect(
      screen.getByText('This deployment did not install this agentic tool')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Workspace settings cannot install deployment packages/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Credential resolution')).not.toBeInTheDocument();
    expect(screen.queryByText('Allow inline configuration')).not.toBeInTheDocument();
  });

  it('discards a credential/settings read from an older auth generation', async () => {
    let resolve!: (value: TenantAgenticToolSettings[]) => void;
    const oldRead = new Promise<TenantAgenticToolSettings[]>((done) => {
      resolve = done;
    });
    const currentSettings: TenantAgenticToolSettings[] = tools.map((tool) => ({
      tool,
      deployment_available: true,
      enabled: true,
      resolution_policy: 'user_preferred',
      inline_configuration_allowed: true,
      connection: {},
    }));
    const find = vi
      .fn()
      .mockImplementationOnce(() => oldRead)
      .mockResolvedValueOnce(currentSettings);
    const client = { service: vi.fn(() => ({ find })) } as unknown as AgorClient;
    const view = (generation: number) => (
      <AgenticToolsSection
        client={client}
        identityKey="admin-a:admin"
        operationScope={['admin-a:admin', client, generation]}
      />
    );
    const rendered = render(view(1));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    rendered.rerender(view(2));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Credential resolution')).toBeInTheDocument();

    await act(async () => {
      resolve(
        currentSettings.map((setting) => ({
          ...setting,
          deployment_available: false,
          enabled: false,
        }))
      );
      await oldRead;
    });
    expect(screen.queryByText('Not installed by this deployment')).not.toBeInTheDocument();
  });
});

describe('AgenticToolsSection preset editor', () => {
  it('keeps one preset editor open across tools and guards a tool switch with a draft', async () => {
    const settings: TenantAgenticToolSettings[] = tools.map((tool) => ({
      tool,
      deployment_available: true,
      enabled: true,
      resolution_policy: 'user_preferred',
      inline_configuration_allowed: true,
      connection: {},
    }));
    const client = {
      service: vi.fn((path: string) => ({
        find: vi.fn().mockResolvedValue(path === 'agentic-tool-presets' ? [] : settings),
        create: vi.fn(),
        patch: vi.fn(),
        remove: vi.fn(),
      })),
    } as unknown as AgorClient;
    renderWithSettingsShell(
      <AgenticToolsSection
        client={client}
        identityKey="admin:admin"
        operationScope={['admin:admin', client, 1]}
      />,
      'agentic-tools'
    );
    const confirms = () => document.querySelectorAll('.ant-modal-confirm').length;
    // Text queries: role queries over every mounted tool pane are slow in jsdom.
    const tab = (label: string) => screen.getByText(label).closest('[role="tab"]') as HTMLElement;

    fireEvent.click(await screen.findByText('Presets'));
    fireEvent.click(await screen.findByText('New preset'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Claude draft' } });

    fireEvent.click(tab('Codex'));
    await waitFor(() => expect(confirms()).toBe(1));
    fireEvent.click(screen.getByText('Keep editing'));
    expect(screen.getByLabelText('Name')).toHaveValue('Claude draft');
    expect(tab('Claude Code')).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(tab('Codex'));
    fireEvent.click(await screen.findByText('Discard'));
    await waitFor(() => expect(tab('Codex')).toHaveAttribute('aria-selected', 'true'));
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });
});
