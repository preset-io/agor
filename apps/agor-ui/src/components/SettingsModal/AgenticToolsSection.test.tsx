import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  enabled: boolean;
  resolution_policy: string;
  inline_configuration_allowed: boolean;
  connection: Record<string, { configured: boolean }>;
};

const row = (tool: string, enabled = true): Row => ({
  tool,
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

const renderSection = (rows: Row[]) =>
  render(
    <AntdApp>
      <AgenticToolsSection client={makeClient(rows)} />
    </AntdApp>
  );

const allEnabled = () =>
  ['claude-code', 'codex', 'gemini', 'copilot', 'cursor', 'opencode'].map((t) => row(t));

describe('AgenticToolsSection', () => {
  it('renders a single tab level (tool selection is a sidebar menu, not nested tabs)', async () => {
    renderSection(allEnabled());

    // The tool switcher is a menu, and the only <Tabs> is the inner
    // Authentication/Presets split — so exactly one tablist, not two.
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Authentication' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Presets' })).toBeInTheDocument();
  });

  it('defaults to the first enabled tool and lists every tool in the switcher', async () => {
    renderSection([row('claude-code', false), row('codex', true), row('gemini')]);

    const menu = await screen.findByRole('menu');
    for (const label of ['Claude Code', 'Codex', 'Gemini']) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
    // Claude Code is disabled, so the first enabled tool (Codex) is active.
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeInTheDocument();
  });

  it('switching tools updates the right-hand panel', async () => {
    renderSection(allEnabled());

    expect(await screen.findByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /Gemini/ }));

    expect(await screen.findByRole('heading', { name: 'Gemini' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Claude Code' })).not.toBeInTheDocument();
  });

  it('switches the Authentication/Presets sub-tab and keeps it when changing tools', async () => {
    renderSection(allEnabled());

    await screen.findByRole('heading', { name: 'Claude Code' });
    // Authentication is the default sub-tab.
    expect(screen.getByText('Credential resolution')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Presets' }));
    expect(await screen.findByText('Allow inline configuration')).toBeInTheDocument();
    expect(screen.getByTestId('presets-manager')).toHaveTextContent('presets:claude-code');

    // The sub-tab selection persists across a tool switch.
    fireEvent.click(screen.getByRole('menuitem', { name: /Codex/ }));
    expect(await screen.findByRole('heading', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.getByTestId('presets-manager')).toHaveTextContent('presets:codex');
  });

  it('marks a disabled tool in the switcher without relying on color alone', async () => {
    renderSection([
      row('claude-code', true),
      row('codex', false),
      row('gemini'),
      row('copilot'),
      row('cursor'),
      row('opencode'),
    ]);

    const menu = await screen.findByRole('menu');
    // Screen-reader text distinguishes availability beyond the status dot color.
    expect(within(menu).getByText('Disabled')).toBeInTheDocument();
    expect(within(menu).getAllByText('Available').length).toBeGreaterThan(0);
  });
});
