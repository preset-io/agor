import type { AgorClient, BranchID, Schedule } from '@agor-live/client';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleModal } from './ScheduleModal';

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
    AgenticToolConfigurationPicker: ({ defaultResolution }: { defaultResolution?: string }) => {
      const form = AntForm.useFormInstance();
      return (
        <div data-testid="configuration-picker" data-default-resolution={defaultResolution}>
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

function renderModal(patch: ReturnType<typeof vi.fn>, onClose = vi.fn()) {
  const schedule = makeSchedule();
  const client = {
    service: () => ({
      patch,
      create: vi.fn(),
    }),
  } as unknown as AgorClient;
  render(
    <ScheduleModal
      open
      onClose={onClose}
      branchId={schedule.branch_id}
      branchName="Feature"
      schedule={schedule}
      mcpServerById={new Map()}
      client={client}
    />
  );
  return { schedule, onClose };
}

describe('ScheduleModal agentic configuration payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks the shared picker as resolving schedule defaults per run', async () => {
    renderModal(vi.fn());
    expect(await screen.findByTestId('configuration-picker')).toHaveAttribute(
      'data-default-resolution',
      'schedule-run'
    );
  });

  it.each([
    ['Choose user default', USER_DEFAULT_AGENTIC_CONFIGURATION],
    ['Choose workspace default', WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION],
  ])('submits %s as a configuration reference', async (buttonName, reference) => {
    const schedule = makeSchedule();
    const patch = vi.fn(async (_id, payload) => ({ ...schedule, ...payload }));
    renderModal(patch);

    fireEvent.click(await screen.findByRole('button', { name: buttonName }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch.mock.calls[0][1].agentic_tool_config).toEqual({
      agentic_tool: 'codex',
      configuration_reference: reference,
    });
  });

  it('removes stale source fields when switching a default-backed schedule to inline', async () => {
    const schedule = makeSchedule();
    const patch = vi.fn(async (_id, payload) => ({ ...schedule, ...payload }));
    renderModal(patch);

    fireEvent.click(await screen.findByRole('button', { name: 'Choose inline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    const config = patch.mock.calls[0][1].agentic_tool_config;
    expect(config.configuration_reference).toBeUndefined();
    expect(config.preset_id).toBeUndefined();
  });

  it('keeps form values and the modal open when patching is rejected', async () => {
    const patch = vi.fn(async () => {
      throw new Error('Selected agentic configuration is not available');
    });
    const onClose = vi.fn();
    renderModal(patch, onClose);

    fireEvent.click(await screen.findByRole('button', { name: 'Choose workspace default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(messageMocks.showError).toHaveBeenCalledWith(
        'Selected agentic configuration is not available'
      )
    );
    expect(patch).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('configuration-selection')).toHaveTextContent(
      WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
