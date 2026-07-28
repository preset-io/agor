import type { BranchID, Session, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ZoneTriggerModal } from './ZoneTriggerModal';

// Isolate the modal's own smart-default selection logic from its heavy config
// children — the regression lives entirely in ZoneTriggerModal's render-time
// useMemo, which runs regardless of what these children render.
vi.mock('../../AgentSelectionGrid', () => ({
  AgentSelectionGrid: ({ onSelect }: { onSelect: (agent: string) => void }) => (
    <button type="button" onClick={() => onSelect('opencode')}>
      OpenCode
    </button>
  ),
}));
vi.mock('../../AgenticToolConfigForm', () => ({
  AgenticToolConfigForm: () => null,
}));
vi.mock('../../AgenticToolConfigurationPicker', () => {
  const ModelConfigControl = ({
    value,
    onChange,
  }: {
    value?: { mode: 'exact'; provider?: string; model: string };
    onChange?: (value: { mode: 'exact'; provider?: string; model: string } | undefined) => void;
  }) => (
    <div>
      <output data-testid="zone-model">
        {value ? `${value.provider ?? ''}/${value.model}` : ''}
      </output>
      <button type="button" onClick={() => onChange?.(undefined)}>
        Clear zone model
      </button>
      <button
        type="button"
        onClick={() => onChange?.({ mode: 'exact', provider: 'anthropic', model: 'claude-4' })}
      >
        Complete zone model
      </button>
    </div>
  );

  return {
    INLINE_AGENTIC_CONFIGURATION: '__inline__',
    AgenticToolConfigurationPicker: () => (
      <>
        <Form.Item name="agenticToolPresetId">
          <select aria-label="Zone configuration source">
            <option value="">Inherit</option>
            <option value="__user_default__">My default</option>
            <option value="__inline__">Inline</option>
          </select>
        </Form.Item>
        <Form.Item name="modelConfig">
          <ModelConfigControl />
        </Form.Item>
      </>
    ),
  };
});

const BRANCH_ID = 'branch-1' as BranchID;

const makeSession = (id: string, status: string, lastUpdated: string, title: string): Session =>
  ({
    session_id: id,
    branch_id: BRANCH_ID,
    status,
    title,
    archived: false,
    created_at: '2026-01-01T00:00:00.000Z',
    last_updated: lastUpdated,
  }) as unknown as Session;

describe('ZoneTriggerModal smart-default session selection', () => {
  it('resolves the most-recent session without mutating the frozen store bucket', () => {
    const older = makeSession('s-old', 'completed', '2026-06-01T00:00:00.000Z', 'Older session');
    const newer = makeSession('s-new', 'completed', '2026-06-20T00:00:00.000Z', 'Newer session');

    // The store uses Immer, which deeply freezes every `sessionsByBranch`
    // bucket. Sorting such an array in place throws, so the modal must sort a
    // copy. Freeze here to reproduce the store's contract.
    const frozenBucket = Object.freeze([older, newer]);
    const sessionsByBranch = new Map<string, Session[]>([[BRANCH_ID, frozenBucket]]);

    expect(() =>
      render(
        <ZoneTriggerModal
          open
          onCancel={() => {}}
          client={null}
          branchId={BRANCH_ID}
          branch={undefined}
          sessionsByBranch={sessionsByBranch}
          zoneName="Zone"
          trigger={{ template: 'do {{thing}}' } as never}
          availableAgents={[]}
          mcpServerById={new Map()}
          onExecute={async () => {}}
        />
      )
    ).not.toThrow();

    // With no running sessions, the smart default is the most-recently-updated
    // session — surfaced as the closed Select's selected value.
    expect(document.body.textContent).toContain('Newer session');
    expect(document.body.textContent).not.toContain('Older session');
  });
});

const staleOpenCodeDefault = {
  user_id: 'user-1',
  default_agentic_config: {
    opencode: {
      modelConfig: {
        mode: 'exact',
        provider: 'openai',
        model: 'gpt-5',
      },
    },
  },
} as unknown as User;

function renderNewSessionModal(currentUser?: User) {
  const onExecute = vi.fn(async () => {});
  render(
    <ZoneTriggerModal
      open
      onCancel={() => {}}
      client={null}
      branchId={BRANCH_ID}
      branch={undefined}
      sessionsByBranch={new Map()}
      zoneName="Zone"
      trigger={{ template: 'do work' } as never}
      availableAgents={[{ id: 'opencode', name: 'OpenCode', icon: 'O', description: 'OpenCode' }]}
      mcpServerById={new Map()}
      currentUser={currentUser}
      onExecute={onExecute}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));
  fireEvent.click(screen.getByRole('button', { name: /Agentic Tool Configuration \(optional\)/ }));
  return onExecute;
}

describe('ZoneTriggerModal OpenCode new-session configuration', () => {
  it('omits an inline clear so the daemon resolves the personal exact pair', async () => {
    const onExecute = renderNewSessionModal(staleOpenCodeDefault);
    await waitFor(() => expect(screen.getByTestId('zone-model')).toHaveTextContent('openai/gpt-5'));

    fireEvent.change(screen.getByRole('combobox', { name: 'Zone configuration source' }), {
      target: { value: '__inline__' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear zone model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Execute Trigger' }));

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0][0].modelConfig).toBeUndefined();
  });

  it('keeps an omitted override omitted so defaults can be inherited', async () => {
    const onExecute = renderNewSessionModal();
    fireEvent.click(screen.getByRole('button', { name: 'Execute Trigger' }));

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0][0].modelConfig).toBeUndefined();
  });

  it('serializes a reference without the prefilled inline model', async () => {
    const onExecute = renderNewSessionModal(staleOpenCodeDefault);
    await waitFor(() => expect(screen.getByTestId('zone-model')).toHaveTextContent('openai/gpt-5'));

    fireEvent.change(screen.getByRole('combobox', { name: 'Zone configuration source' }), {
      target: { value: '__user_default__' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Execute Trigger' }));

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0][0].agenticToolPresetId).toBe('__user_default__');
    expect(onExecute.mock.calls[0][0].modelConfig).toBeUndefined();
    expect(onExecute.mock.calls[0][0].permissionMode).toBeUndefined();
  });

  it('keeps a complete inline provider/model pair exact', async () => {
    const onExecute = renderNewSessionModal(staleOpenCodeDefault);
    await waitFor(() => expect(screen.getByTestId('zone-model')).toHaveTextContent('openai/gpt-5'));

    fireEvent.change(screen.getByRole('combobox', { name: 'Zone configuration source' }), {
      target: { value: '__inline__' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Complete zone model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Execute Trigger' }));

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0][0].modelConfig).toEqual({
      mode: 'exact',
      provider: 'anthropic',
      model: 'claude-4',
    });
  });
});
