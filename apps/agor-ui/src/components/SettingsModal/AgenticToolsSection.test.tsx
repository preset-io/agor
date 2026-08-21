import type {
  AgorClient,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
} from '@agor-live/client';
import { render, screen } from '@testing-library/react';
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

    render(<AgenticToolsSection client={client} authorityKey="admin-a:admin" />);

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
});
