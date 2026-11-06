import type { AgorClient, BranchID, Schedule } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleTriggerSection } from './ScheduleTriggerSection';

const messageMocks = vi.hoisted(() => ({ showError: vi.fn(), showSuccess: vi.fn() }));
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn(async () => true) }));

vi.mock('../../utils/message', () => ({ useThemedMessage: () => messageMocks }));
vi.mock('../../utils/clipboard', () => clipboard);
vi.mock('@/config/daemon', () => ({ getDaemonUrl: () => 'https://agor.example.test' }));

const SCHEDULE_ID = '00000000-0000-7000-8000-000000000001';
const TOKEN = 'agor_trg_secret-value';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    schedule_id: SCHEDULE_ID,
    branch_id: '00000000-0000-7000-8000-000000000002' as BranchID,
    name: 'Feature announcements',
    cron_expression: '0 9 * * *',
    timezone_mode: 'utc',
    prompt: 'Draft feature announcements',
    agentic_tool_config: { agentic_tool: 'claude-code' },
    enabled: true,
    allow_concurrent_runs: false,
    retention: 5,
    trigger_enabled: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'owner',
    ...overrides,
  } as Schedule;
}

function renderSection(schedule: Schedule, canManage = true) {
  const create = vi.fn(async ({ action }: { action: string }) =>
    action === 'disable'
      ? { schedule_id: SCHEDULE_ID, trigger_enabled: false }
      : { schedule_id: SCHEDULE_ID, trigger_enabled: true, token: TOKEN }
  );
  const service = vi.fn(() => ({ create }));
  render(
    <AntApp>
      <ScheduleTriggerSection
        client={{ service } as unknown as AgorClient}
        schedule={schedule}
        canManage={canManage}
      />
    </AntApp>
  );
  return { create, service };
}

describe('ScheduleTriggerSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('turns the trigger on and shows the token once with copyable commands', async () => {
    const { create, service } = renderSection(makeSchedule());

    fireEvent.click(screen.getByRole('button', { name: 'Turn on trigger URL' }));

    await waitFor(() => expect(screen.getByLabelText('Trigger token')).toHaveValue(TOKEN));
    expect(service).toHaveBeenCalledWith(`schedules/${SCHEDULE_ID}/trigger-token`);
    expect(create).toHaveBeenCalledWith({ action: 'enable' });
    expect(
      screen.getByText(`POST https://agor.example.test/schedules/${SCHEDULE_ID}/trigger`)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Copy curl command/ }));
    await waitFor(() =>
      expect(clipboard.copyToClipboard).toHaveBeenCalledWith(
        `curl -X POST -H "Authorization: Bearer ${TOKEN}" https://agor.example.test/schedules/${SCHEDULE_ID}/trigger`
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('Trigger token')).not.toBeInTheDocument();
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
  });

  it('rotates and turns off an enabled trigger after confirmation', async () => {
    const { create } = renderSection(makeSchedule({ trigger_enabled: true }));
    expect(screen.queryByLabelText('Trigger token')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate token' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ action: 'rotate' }));
    await waitFor(() => expect(screen.getByLabelText('Trigger token')).toHaveValue(TOKEN));

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    // The Popconfirm's confirm button shares the label; it renders last.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Turn off' })).toHaveLength(2)
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Turn off' }).at(-1)!);
    await waitFor(() => expect(create).toHaveBeenCalledWith({ action: 'disable' }));
    expect(await screen.findByRole('button', { name: 'Turn on trigger URL' })).toBeInTheDocument();
  });

  it('hides management controls from non-owners', () => {
    renderSection(makeSchedule(), false);
    expect(screen.queryByRole('button', { name: 'Turn on trigger URL' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the schedule's owner can turn it on/)).toBeInTheDocument();
  });
});
