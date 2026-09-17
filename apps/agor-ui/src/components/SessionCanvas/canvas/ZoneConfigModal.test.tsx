// biome-ignore-all lint/plugin/noHardcodedColorLiteral: persisted color fixtures verify legacy zone migration
import type { BoardObject, ZoneBoardObject } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    // The Appearance pane is force-rendered (but hidden) so its Name field
    // registers with the Form even if the operator never opens this tab.
    expect(screen.getByText('Appearance')).not.toBeVisible();

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

  it('preserves the zone name when saving a prompt template without visiting the Appearance tab', async () => {
    const onUpdate = vi.fn().mockResolvedValue(true);
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

    expect(screen.getByRole('tab', { name: /Automation/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    fireEvent.change(screen.getByLabelText('Prompt template'), {
      target: { value: 'Review this branch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({ label: 'Review' });
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
});

describe('ZoneConfigModal draft and save lifecycle', () => {
  const zone: ZoneBoardObject = {
    type: 'zone',
    x: 10,
    y: 20,
    width: 200,
    height: 100,
    label: 'Review',
    locked: true,
    borderColor: '#123456',
    backgroundColor: '#abcdef',
    fontSize: 22,
    status: 'Ready',
    zIndex: 42,
    trigger: { behavior: 'always_new', template: 'Old prompt', agent: 'codex' },
  };

  function mount(onUpdate = vi.fn().mockResolvedValue(true)) {
    const onCancel = vi.fn();
    const props = {
      open: true,
      objectId: 'zone-1',
      zoneName: zone.label,
      zoneData: zone,
      onUpdate,
      onCancel,
    };
    const view = render(
      <AntdApp>
        <ZoneConfigModal {...props} />
      </AntdApp>
    );
    return {
      ...view,
      onUpdate,
      onCancel,
      rerenderProps: (patch: Partial<typeof props> & { canEdit?: boolean }) =>
        view.rerender(
          <AntdApp>
            <ZoneConfigModal {...props} {...patch} />
          </AntdApp>
        ),
    };
  }

  it('keeps local prompt edits but preserves received collaborator updates when saving', async () => {
    const v = mount();
    fireEvent.change(screen.getByLabelText('Prompt template'), {
      target: { value: 'Local draft' },
    });
    const latest: ZoneBoardObject = {
      ...zone,
      label: 'Remote name',
      locked: false,
      borderColor: '#654321',
      backgroundColor: undefined,
      fontSize: 30,
      x: 99,
      zIndex: 45,
      trigger: { behavior: 'show_picker', template: 'Remote prompt', agent: 'claude-code' },
    };
    v.rerenderProps({ zoneName: latest.label, zoneData: latest });
    expect(screen.getByLabelText('Prompt template')).toHaveValue('Local draft');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(v.onUpdate).toHaveBeenCalledExactlyOnceWith('zone-1', {
        ...latest,
        trigger: { ...latest.trigger, template: 'Local draft' },
      })
    );
  });

  it('saves explicit name and prompt clearing without resetting untouched appearance', async () => {
    const v = mount();
    fireEvent.change(screen.getByLabelText('Prompt template'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance & placement' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(v.onUpdate).toHaveBeenCalledExactlyOnceWith('zone-1', {
        ...zone,
        label: '',
        trigger: undefined,
      })
    );
  });

  it('does not save old drafts after cancel/reopen or switching zones', async () => {
    const v = mount();
    fireEvent.change(screen.getByLabelText('Prompt template'), { target: { value: 'Discard me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    v.rerenderProps({ open: false });
    const other = { ...zone, label: 'Other', trigger: undefined };
    v.rerenderProps({ objectId: 'zone-2', zoneName: other.label, zoneData: other });
    expect(screen.getByLabelText('Prompt template')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Prompt template'), {
      target: { value: 'Other draft' },
    });
    // Also support a caller switching the identity without an intervening close.
    v.rerenderProps({ objectId: 'zone-3' });
    expect(screen.getByLabelText('Prompt template')).toHaveValue('Old prompt');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(v.onCancel).toHaveBeenCalledTimes(2));
    expect(v.onUpdate).not.toHaveBeenCalled();
  });

  it.each(['success', 'false', 'reject'])(
    'locks the draft during save and recovers after %s',
    async (outcome) => {
      let resolve!: (value: boolean) => void;
      let reject!: (error: Error) => void;
      const onUpdate = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<boolean>((yes, no) => {
              resolve = yes;
              reject = no;
            })
        )
        .mockResolvedValue(true);
      const v = mount(onUpdate);
      fireEvent.change(screen.getByLabelText('Prompt template'), {
        target: { value: 'Saved draft' },
      });
      const save = screen.getByRole('button', { name: 'Save' });
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      fireEvent.click(save);
      fireEvent.click(save);
      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      expect(save).toBeDisabled();
      expect(screen.getByLabelText('Prompt template')).toBeDisabled();
      expect(screen.getByLabelText('Name')).toBeDisabled();
      expect(screen.getByLabelText('Prompt template').closest('form')).toHaveAttribute('inert');
      // Avoid jsdom/cssstyle's disabled-button CSS-variable shorthand crash.
      expect(cancel).toBeDisabled();
      expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
      fireEvent.click(cancel);
      expect(v.onCancel).not.toHaveBeenCalled();
      await act(async () => {
        if (outcome === 'reject') reject(new Error('Persistence failed'));
        else resolve(outcome === 'success');
      });
      if (outcome === 'success') {
        expect(v.onCancel).toHaveBeenCalledTimes(1);
      } else {
        expect(v.onCancel).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Prompt template')).toHaveValue('Saved draft');
        expect(screen.getByLabelText('Prompt template')).toBeEnabled();
        expect(screen.getByLabelText('Prompt template').closest('form')).not.toHaveAttribute(
          'inert'
        );
        // The failed request must not establish a new baseline or overwrite a new live name.
        v.rerenderProps({ zoneName: 'Remote', zoneData: { ...zone, label: 'Remote' } });
        fireEvent.click(save);
        await waitFor(() => expect(v.onCancel).toHaveBeenCalledTimes(1));
        expect(onUpdate.mock.calls[1][1]).toMatchObject({
          label: 'Remote',
          trigger: { template: 'Saved draft' },
        });
      }
    }
  );

  it('does not close a replacement zone when an old request completes', async () => {
    let resolve!: (value: boolean) => void;
    const v = mount(
      vi.fn().mockReturnValue(
        new Promise<boolean>((yes) => {
          resolve = yes;
        })
      )
    );
    fireEvent.change(screen.getByLabelText('Prompt template'), {
      target: { value: 'Old zone edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(v.onUpdate).toHaveBeenCalledTimes(1));
    v.rerenderProps({
      objectId: 'zone-2',
      zoneName: 'Other',
      zoneData: { ...zone, label: 'Other' },
    });
    await act(async () => {
      resolve(true);
    });
    expect(v.onCancel).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name')).toHaveValue('Other');
  });

  it.each(['update', 'revoke'])('rechecks latest props after validation: %s', async (change) => {
    const v = mount();
    fireEvent.change(screen.getByLabelText('Prompt template'), {
      target: { value: 'Local draft' },
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      v.rerenderProps({
        zoneName: 'Latest name',
        zoneData: { ...zone, label: 'Latest name' },
        canEdit: change !== 'revoke',
      });
    });
    if (change === 'revoke') {
      await waitFor(() => expect(screen.getByLabelText('Prompt template')).toBeEnabled());
      expect(v.onUpdate).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(v.onUpdate).toHaveBeenCalledTimes(1));
      expect(v.onUpdate.mock.calls[0][1]).toMatchObject({
        label: 'Latest name',
        trigger: { template: 'Local draft' },
      });
    }
  });

  it('does not submit when edit permission is revoked while open', async () => {
    const v = mount();
    fireEvent.change(screen.getByLabelText('Prompt template'), {
      target: { value: 'Not allowed' },
    });
    v.rerenderProps({ canEdit: false });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(v.onUpdate).not.toHaveBeenCalled();
  });
});
