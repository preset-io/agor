import type { BoardObject } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ZoneConfigModal } from './ZoneConfigModal';

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
  it('makes inherited state understandable, resettable, and focusable', async () => {
    const onUpdate = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          boardZoneLayoutDefaults={{
            mode: 'auto',
            preset: 'compact_list',
            sortBy: 'updated',
            sortDirection: 'desc',
            gap: 8,
          }}
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

    const inherit = await screen.findByRole('switch', { name: 'Use board defaults' });
    const spacing = screen.getByRole('spinbutton', { name: 'Spacing' });
    expect(inherit).toBeChecked();
    expect(spacing).toBeDisabled();
    expect(spacing).toHaveValue('8');
    expect(screen.getByText(/follows Zone defaults from Board settings/)).toBeInTheDocument();

    inherit.focus();
    expect(inherit).toHaveFocus();
    fireEvent.click(inherit);
    expect(inherit).not.toBeChecked();
    expect(spacing).toBeEnabled();
    fireEvent.change(spacing, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout_binding: 'override',
      layout: { mode: 'auto', preset: 'compact_list', gap: 4 },
    });
  });

  it('resets an explicit override to current board defaults only by intent', async () => {
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
            layout: { mode: 'auto', preset: 'grid', gap: 40 },
          }}
        />
      </AntdApp>
    );

    const inherit = await screen.findByRole('switch', { name: 'Use board defaults' });
    expect(inherit).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Spacing' })).toHaveValue('40');
    fireEvent.click(inherit);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout_binding: 'inherit',
      layout: { mode: 'manual', preset: 'grid', gap: 4 },
    });
  });

  it('selects and persists the List presentation', async () => {
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
            width: 620,
            height: 900,
            label: 'Review',
            layout: { mode: 'manual', preset: 'grid' },
          }}
        />
      </AntdApp>
    );

    const list = await screen.findByText('List', { selector: '.ant-segmented-item-label' });
    fireEvent.click(list);
    expect(list.closest('.ant-segmented-item')).toHaveClass('ant-segmented-item-selected');
    await waitFor(() =>
      expect(screen.queryByRole('spinbutton', { name: 'Columns' })).not.toBeInTheDocument()
    );
    expect(
      await screen.findByText(/List uses one column. It does not change content expansion/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout: { preset: 'compact_list', columns: 1 },
    });
  });

  it('shows a persisted manual demotion by turning the Auto Zone control off', async () => {
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={vi.fn()}
          zoneData={{
            type: 'zone',
            x: 0,
            y: 0,
            width: 620,
            height: 900,
            label: 'Review',
            layout: { mode: 'manual', preset: 'grid' },
          }}
        />
      </AntdApp>
    );

    expect(await screen.findByRole('switch', { name: 'Auto Zone' })).not.toBeChecked();
    expect(
      screen.getByText(/settings below remain saved and apply when you choose Tidy/)
    ).toBeInTheDocument();
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

  it('uses latest-first as the opinionated default when automatic layout is enabled', async () => {
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
            width: 620,
            height: 900,
            label: 'Review',
          }}
        />
      </AntdApp>
    );

    fireEvent.click(await screen.findByRole('switch', { name: 'Auto Zone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout: {
        mode: 'auto',
        preset: 'grid',
        sortBy: 'updated',
        sortDirection: 'desc',
        autoResizeHeight: false,
        gap: 24,
      },
    });
  });

  it('pairs Grow to fit with minimal collision reflow while preserving the public policy field', async () => {
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
            width: 620,
            height: 300,
            label: 'Review',
          }}
        />
      </AntdApp>
    );

    const overflow = await screen.findByRole('combobox', { name: 'When growth overlaps' });
    expect(overflow).toBeDisabled();
    expect(
      screen.getByText(/Enable Grow to fit before choosing an overlap action/)
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('switch', { name: 'Grow to fit' }));
    await waitFor(() => expect(overflow).toBeEnabled());
    expect(screen.getByText('Move neighboring zones')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout: {
        autoResizeHeight: true,
        resize: 'height',
        onOverflow: 'reflow_board',
      },
    });
  });

  it('preserves the MCP-only both-axis grow mode when saving another field', async () => {
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
            width: 620,
            height: 300,
            label: 'Review',
            layout: { resize: 'both', onOverflow: 'report' },
          }}
        />
      </AntdApp>
    );

    fireEvent.change(await screen.findByLabelText('Zone name'), { target: { value: 'Ready' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout: { resize: 'both', autoResizeHeight: true, onOverflow: 'report' },
    });
  });

  it('does not write unchanged configuration and keeps the accessible toggle focusable', async () => {
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
          zoneData={{ type: 'zone', x: 0, y: 0, width: 620, height: 900, label: 'Review' }}
        />
      </AntdApp>
    );

    const autoZone = await screen.findByRole('switch', { name: 'Auto Zone' });
    autoZone.focus();
    expect(autoZone).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('waits for durable persistence before closing and stays open after a rejected save result', async () => {
    let resolveSave: ((value: boolean) => void) | undefined;
    const onUpdate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSave = resolve;
        })
    );
    const onCancel = vi.fn();
    const view = render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={onCancel}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          zoneData={{ type: 'zone', x: 0, y: 0, width: 620, height: 900, label: 'Review' }}
        />
      </AntdApp>
    );

    fireEvent.change(await screen.findByLabelText('Zone name'), { target: { value: 'Ready' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => resolveSave?.(false));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    view.unmount();
  });
});
