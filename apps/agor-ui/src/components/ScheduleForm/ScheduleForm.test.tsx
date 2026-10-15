import type { AgorClient, BranchID, Schedule } from '@agor-live/client';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleForm } from './ScheduleForm';

const messageMocks = vi.hoisted(() => ({ showError: vi.fn(), showSuccess: vi.fn() }));

vi.mock('../../utils/message', () => ({
  useThemedMessage: () => messageMocks,
}));
vi.mock('../AgentSelectionGrid', () => ({
  AVAILABLE_AGENTS: [],
  AgentSelectionGrid: () => <div data-testid="agent-grid" />,
}));
vi.mock('react-js-cron', () => ({ Cron: () => <div data-testid="cron-picker" /> }));
vi.mock('../AgenticToolConfigurationPicker', async () => {
  const { Form: AntForm } = await import('antd');
  return {
    INLINE_AGENTIC_CONFIGURATION: '__inline__',
    AgenticToolConfigurationPicker: ({
      defaultResolution,
      modelCatalogClient,
    }: {
      defaultResolution?: string;
      modelCatalogClient?: AgorClient | null;
    }) => {
      const form = AntForm.useFormInstance();
      return (
        <div
          data-testid="configuration-picker"
          data-default-resolution={defaultResolution}
          data-model-catalog={modelCatalogClient === null ? 'closed' : 'open'}
        >
          <AntForm.Item noStyle shouldUpdate>
            {({ getFieldValue }) => (
              <span data-testid="configuration-selection">
                {getFieldValue('agenticToolPresetId')}
              </span>
            )}
          </AntForm.Item>
          <button
            type="button"
            onClick={() => form.setFieldValue('agenticToolPresetId', '__user_default__')}
          >
            Choose user default
          </button>
          <button
            type="button"
            onClick={() => form.setFieldValue('agenticToolPresetId', '__workspace_default__')}
          >
            Choose workspace default
          </button>
          <button
            type="button"
            onClick={() => form.setFieldValue('agenticToolPresetId', '__inline__')}
          >
            Choose inline
          </button>
        </div>
      );
    },
  };
});

function makeSchedule(): Schedule {
  return {
    schedule_id: '00000000-0000-7000-8000-000000000001',
    branch_id: '00000000-0000-7000-8000-000000000002' as BranchID,
    name: 'Daily review',
    cron_expression: '0 9 * * *',
    timezone_mode: 'utc',
    prompt: 'Review the branch',
    agentic_tool_config: {
      agentic_tool: 'codex',
      configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
    },
    enabled: true,
    allow_concurrent_runs: false,
    retention: 5,
    created_by: '00000000-0000-7000-8000-000000000003',
    created_at: '2026-07-18T00:00:00.000Z',
    updated_at: '2026-07-18T00:00:00.000Z',
  } as Schedule;
}

function renderForm(
  patch: ReturnType<typeof vi.fn>,
  onClose = vi.fn(),
  schedule: Schedule | null = makeSchedule(),
  {
    create = vi.fn(),
    noClient = false,
    onDraftChange = vi.fn(),
  }: {
    create?: ReturnType<typeof vi.fn>;
    noClient?: boolean;
    onDraftChange?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const client = {
    service: () => ({
      patch,
      create,
    }),
  } as unknown as AgorClient;
  const view = render(
    <AntApp>
      <ScheduleForm
        onClose={onClose}
        branchId={schedule?.branch_id ?? ('00000000-0000-7000-8000-000000000002' as BranchID)}
        schedule={schedule}
        mcpServerById={new Map()}
        client={noClient ? null : client}
        onDraftChange={onDraftChange}
      />
    </AntApp>
  );
  return { schedule, onClose, view };
}

describe('ScheduleForm agentic configuration payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks the shared picker as resolving schedule defaults per run', async () => {
    renderForm(vi.fn());
    expect(await screen.findByTestId('configuration-picker')).toHaveAttribute(
      'data-default-resolution',
      'schedule-run'
    );
  });

  it('fails the model catalog closed when the schedule owner is not the caller', async () => {
    renderForm(vi.fn());
    expect(await screen.findByTestId('configuration-picker')).toHaveAttribute(
      'data-model-catalog',
      'closed'
    );
  });

  it('preserves a removed tool as historical configuration until explicitly replaced', async () => {
    const historicalSchedule = {
      ...makeSchedule(),
      agentic_tool_config: {
        agentic_tool: 'claude-code-cli',
        permission_mode: 'auto',
      },
    } as Schedule;

    renderForm(vi.fn(), vi.fn(), historicalSchedule);

    expect(
      await screen.findByText("This schedule uses an agent that's no longer available")
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByTestId('configuration-picker')).not.toBeInTheDocument();
  });

  it.each([
    ['Choose user default', USER_DEFAULT_AGENTIC_CONFIGURATION],
    ['Choose workspace default', WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION],
  ])('submits %s as a configuration reference', async (buttonName, reference) => {
    const schedule = makeSchedule();
    const patch = vi.fn(async (_id, payload) => ({ ...schedule, ...payload }));
    renderForm(patch);

    fireEvent.click(await screen.findByRole('button', { name: buttonName }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch.mock.calls[0][1]).not.toHaveProperty('branch_id');
    expect(patch.mock.calls[0][1].agentic_tool_config).toEqual({
      agentic_tool: 'codex',
      configuration_reference: reference,
    });
  });

  it('removes stale source fields when switching a default-backed schedule to inline', async () => {
    const schedule = makeSchedule();
    const patch = vi.fn(async (_id, payload) => ({ ...schedule, ...payload }));
    renderForm(patch);

    fireEvent.click(await screen.findByRole('button', { name: 'Choose inline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    const config = patch.mock.calls[0][1].agentic_tool_config;
    expect(config.configuration_reference).toBeUndefined();
    expect(config.preset_id).toBeUndefined();
  });

  it('keeps form values and the form open when patching is rejected', async () => {
    const patch = vi.fn(async () => {
      throw new Error('Selected agentic configuration is not available');
    });
    const onClose = vi.fn();
    renderForm(patch, onClose);

    fireEvent.click(await screen.findByRole('button', { name: 'Choose workspace default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the schedule.");
    expect(messageMocks.showError).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('configuration-selection')).toHaveTextContent(
      WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the not-connected copy in the form when there is no client', async () => {
    const onClose = vi.fn();
    renderForm(vi.fn(), onClose, makeSchedule(), { noClient: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't save the schedule. The connection to Agor dropped. Try again once it's back."
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('tells a create whose reply was lost to refresh before saving again', async () => {
    const create = vi.fn(async () => {
      throw new Error('socket has been disconnected');
    });
    const onClose = vi.fn();
    renderForm(vi.fn(), onClose, null, { create });

    fireEvent.change(await screen.findByPlaceholderText('Hourly heartbeat'), {
      target: { value: 'Nightly' },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'Review the current state of {{branch.name}} and post a status update.'
      ),
      { target: { value: 'Summarize' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(
      await screen.findByText(
        'The connection to Agor dropped before this was confirmed. Refresh to see if it went through before you try to save the schedule again.'
      )
    ).toBeInTheDocument();
    expect(create).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Hourly heartbeat'), {
      target: { value: 'Nightly run' },
    });
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('asks for a timezone on the field instead of a toast', async () => {
    const patch = vi.fn();
    renderForm(patch, vi.fn(), {
      ...makeSchedule(),
      timezone_mode: 'local',
      timezone: '   ',
    } as Schedule);

    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Choose a timezone.')).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    expect(messageMocks.showError).not.toHaveBeenCalled();
  });
});

describe('ScheduleForm draft', () => {
  const confirms = () => document.querySelectorAll('.ant-modal-confirm').length;

  it('cancels a clean form at once', async () => {
    const onClose = vi.fn();
    renderForm(vi.fn(), onClose);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(confirms()).toBe(0);
  });

  it('hands up its draft getter, asks before Cancel or the crumb discard it, and clears it on unmount', async () => {
    const onClose = vi.fn();
    const onDraftChange = vi.fn();
    const { view } = renderForm(vi.fn(), onClose, makeSchedule(), { onDraftChange });
    fireEvent.change(await screen.findByDisplayValue('Daily review'), {
      target: { value: 'Nightly review' },
    });
    const isDirty = onDraftChange.mock.lastCall?.[0] as () => boolean;
    expect(isDirty()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(confirms()).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(confirms()).toBe(0));
    fireEvent.click(screen.getByText('Schedules'));
    await waitFor(() => expect(confirms()).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onClose).not.toHaveBeenCalled();

    view.unmount();
    expect(onDraftChange).toHaveBeenLastCalledWith(null);
  });
});
