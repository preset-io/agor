import type {
  AgorClient,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
} from '@agor-live/client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgenticToolsSection } from './AgenticToolsSection';

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
