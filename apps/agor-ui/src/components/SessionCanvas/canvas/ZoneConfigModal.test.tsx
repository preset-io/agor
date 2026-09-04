// biome-ignore-all lint/plugin/noHardcodedColorLiteral: persisted color fixtures verify legacy zone migration
import type { BoardObject } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ZoneConfigModal } from './ZoneConfigModal';

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  const React = await import('react');
  return {
    ...actual,
    ColorPicker: ({
      children,
      onChange,
    }: {
      children?: React.ReactNode;
      onChange?: (color: { toHexString: () => string }) => void;
    }) => {
      const childProps = React.isValidElement(children)
        ? (children.props as { 'aria-label'?: string })
        : undefined;
      const label = childProps?.['aria-label'] ?? 'color';
      return (
        <div>
          {children}
          <button
            type="button"
            aria-label={`Set ${label}`}
            onClick={() => onChange?.({ toHexString: () => '#123456' })}
          />
        </div>
      );
    },
  };
});

vi.mock('../../../contexts/ConnectionContext', () => ({
  useMutationGate: () => ({ canMutate: true }),
}));

vi.mock('../../AgentSelectionGrid', () => ({
  AVAILABLE_AGENTS: [
    { id: 'claude-code', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
  ],
  AgentSelectionGrid: ({
    agents,
    onSelect,
  }: {
    agents: Array<{ id: string; name: string }>;
    onSelect: (id: string) => void;
  }) => (
    <div>
      {agents.map((agent) => (
        <button key={agent.id} type="button" onClick={() => onSelect(agent.id)}>
          {agent.name}
        </button>
      ))}
    </div>
  ),
}));

function historicalZone(): BoardObject {
  return {
    type: 'zone',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    label: 'Review',
    trigger: {
      behavior: 'always_new',
      template: 'Review this branch',
      agent: 'claude-code-cli',
    },
  } as BoardObject;
}

describe('ZoneConfigModal historical tool migration', () => {
  it('keeps an inherited layout understandable and forks an override only by intent', async () => {
    const onUpdate = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          boardZoneLayoutDefaults={{ mode: 'auto', preset: 'compact_list', gap: 8 }}
          zoneData={{
            type: 'zone',
            x: 0,
            y: 0,
            width: 620,
            height: 900,
            label: 'Review',
            layout_binding: 'inherit',
            layout: { mode: 'auto', preset: 'compact_list', gap: 8 },
          }}
        />
      </AntdApp>
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Layout' }));
    const inherit = await screen.findByRole('switch', { name: 'Use board defaults' });
    const spacing = screen.getByRole('spinbutton', { name: 'Spacing' });
    expect(inherit).toBeChecked();
    expect(spacing).toBeDisabled();
    expect(spacing).toHaveValue('8');
    expect(screen.getByText(/follows Zone defaults from Board settings/)).toBeInTheDocument();

    fireEvent.click(inherit);
    fireEvent.change(spacing, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout_binding: 'override',
      layout: { mode: 'auto', preset: 'compact_list', density: 'preserve', gap: 4 },
    });
  });

  it('resets an explicit layout override to current board defaults only by intent', async () => {
    const onUpdate = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          boardZoneLayoutDefaults={{ mode: 'manual', preset: 'grid', gap: 4 }}
          zoneData={{
            type: 'zone',
            x: 0,
            y: 0,
            width: 620,
            height: 900,
            label: 'Review',
            layout: { mode: 'auto', preset: 'grid', density: 'collapse', gap: 40 },
          }}
        />
      </AntdApp>
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Layout' }));
    const inherit = await screen.findByRole('switch', { name: 'Use board defaults' });
    expect(inherit).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Spacing' })).toHaveValue('40');
    fireEvent.click(inherit);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout_binding: 'inherit',
      layout: { mode: 'manual', preset: 'grid', density: 'preserve', gap: 4 },
    });
  });

  it('preserves the removed tool until the operator explicitly selects a supported one', async () => {
    const onUpdate = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          zoneData={historicalZone()}
        />
      </AntdApp>
    );

    expect(screen.getByRole('tab', { name: /Automation/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(await screen.findByText('This zone uses a removed agentic tool')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      trigger: {
        behavior: 'always_new',
        template: 'Review this branch',
        agent: 'codex',
      },
    });
  });

  it('prioritizes automation and keeps appearance settings in a secondary tab', async () => {
    const onUpdate = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          zoneData={{
            type: 'zone',
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            label: 'Review',
          }}
        />
      </AntdApp>
    );

    expect(screen.getByText('No prompt configured')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt template')).toBeInTheDocument();
    expect(screen.getByLabelText('Trigger behavior')).toBeInTheDocument();
    expect(screen.queryByText('Appearance')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance & placement' }));
    expect(await screen.findByText('Appearance')).toBeInTheDocument();
    expect(screen.getByLabelText('Zone border color')).toBeInTheDocument();
    expect(screen.getByLabelText('Zone fill color')).toBeInTheDocument();
    expect(screen.getByLabelText('Zone label size')).toHaveValue('14');
    expect(screen.getByLabelText('Prompt template')).not.toBeVisible();

    fireEvent.change(screen.getByLabelText('Zone label size'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({ fontSize: 20 });
    expect(onUpdate.mock.calls[0][1].trigger).toBeUndefined();
  });

  it('preserves a legacy translucent fill when the Appearance tab changes its border', async () => {
    const onUpdate = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Legacy"
          objectId="zone-legacy"
          onUpdate={onUpdate}
          zoneData={{
            type: 'zone',
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            label: 'Legacy',
            color: '#ff0000',
          }}
        />
      </AntdApp>
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance & placement' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set Zone border color' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      borderColor: '#123456',
      backgroundColor: 'rgba(255, 0, 0, 0.1)',
    });
  });

  it('keeps automation edits open when persistence reports failure', async () => {
    const onCancel = vi.fn();
    const onUpdate = vi.fn().mockResolvedValue(false);
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={onCancel}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          zoneData={{
            type: 'zone',
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            label: 'Review',
          }}
        />
      </AntdApp>
    );

    const template = screen.getByLabelText('Prompt template');
    fireEvent.change(template, { target: { value: 'Review this branch carefully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(template).toHaveValue('Review this branch carefully');
  });

  it('closes an unchanged zone without writing normalized defaults back', async () => {
    const onUpdate = vi.fn();
    const onCancel = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={onCancel}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          zoneData={{ type: 'zone', x: 0, y: 0, width: 200, height: 100, label: 'Review' }}
        />
      </AntdApp>
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance & placement' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Review')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
