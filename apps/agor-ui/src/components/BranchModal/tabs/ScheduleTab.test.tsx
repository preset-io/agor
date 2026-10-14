import type { AgorClient, Branch, Schedule, User } from '@agor-live/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBranch, renderWithApp } from '../testUtils';
import { ScheduleTab } from './ScheduleTab';

const messageMocks = vi.hoisted(() => ({ showError: vi.fn(), showSuccess: vi.fn() }));
vi.mock('../../../utils/message', () => ({
  useThemedMessage: () => messageMocks,
}));
const scheduleFormProps = vi.hoisted(() => vi.fn());
vi.mock('../../ScheduleForm', () => ({
  ScheduleForm: (props: { onClose: () => void }) => {
    scheduleFormProps(props);
    return (
      <div data-testid="schedule-form">
        <button type="button" onClick={props.onClose}>
          Close form
        </button>
      </div>
    );
  },
}));

// The settings compact breakpoint; desktop unless a test says otherwise.
const media = vi.hoisted(() => ({ compact: false }));
vi.mock('../../../hooks/useMediaQuery', () => ({ useMediaQuery: () => media.compact }));

vi.mock('../../ScheduleRunsPanel', () => ({
  ScheduleRunsPanel: () => null,
}));

const makeSchedule = (overrides: Partial<Schedule> = {}): Schedule =>
  ({
    schedule_id: '018f0000-0000-7000-8000-000000000001',
    branch_id: 'branch-1',
    name: 'Very long customer escalation heartbeat title that should not stretch the modal',
    description: 'Long description that should stay tucked into the title cell and tooltip.',
    cron_expression: '0 8,12,16 * * 1-5',
    timezone_mode: 'local',
    timezone: 'America/Los_Angeles',
    prompt: 'Summarize the branch status.',
    agentic_tool_config: { agentic_tool: 'claude-code' },
    enabled: true,
    allow_concurrent_runs: false,
    retention: 5,
    last_run_at: 1_780_527_200_000,
    last_run_session_id: '018f0000-0000-7000-8000-0000000000aa',
    next_run_at: 1_780_530_800_000,
    created_at: '2026-06-04T00:00:00.000Z',
    updated_at: '2026-06-04T00:00:00.000Z',
    created_by: '018f0000-0000-7000-8000-0000000000bb',
    ...overrides,
  }) as Schedule;

interface ScheduleClientOverrides {
  find?: () => Promise<unknown>;
  patch?: () => Promise<unknown>;
  remove?: () => Promise<unknown>;
  create?: () => Promise<unknown>;
}

const makeScheduleClient = (
  schedules: Schedule[],
  overrides: ScheduleClientOverrides = {}
): AgorClient =>
  ({
    service(path: string) {
      return {
        async find() {
          if (overrides.find) return overrides.find();
          if (path === 'schedules') return { data: schedules };
          return [];
        },
        async patch() {
          return overrides.patch ? overrides.patch() : {};
        },
        async remove() {
          return overrides.remove ? overrides.remove() : {};
        },
        async create() {
          return overrides.create ? overrides.create() : {};
        },
        on() {},
        off() {},
      };
    },
  }) as unknown as AgorClient;

function renderScheduleTab({
  branch = makeBranch(),
  schedules = [makeSchedule()],
  onOpenSession = vi.fn(),
  currentUser,
  userById,
  onDraftChange,
  overrides,
}: {
  branch?: Branch;
  schedules?: Schedule[];
  onOpenSession?: (sessionId: string) => void;
  currentUser?: User;
  userById?: Map<string, User>;
  onDraftChange?: (isDirty: (() => boolean) | null) => void;
  overrides?: ScheduleClientOverrides;
} = {}) {
  renderWithApp(
    <ScheduleTab
      branch={branch}
      client={makeScheduleClient(schedules, overrides)}
      onOpenSession={onOpenSession}
      currentUser={currentUser}
      userById={userById}
      onDraftChange={onDraftChange}
    />
  );
  return { onOpenSession };
}

describe('ScheduleTab compact list', () => {
  beforeEach(() => {
    scheduleFormProps.mockClear();
    vi.clearAllMocks();
  });

  it('keeps secondary schedule details out of full-width columns', async () => {
    renderScheduleTab();

    expect(await screen.findByRole('columnheader', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Next' })).toBeInTheDocument();

    expect(screen.queryByRole('columnheader', { name: /last run/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /scheduled by/i })).not.toBeInTheDocument();

    const title = screen.getByLabelText(/schedule title:/i);
    expect(title).toHaveStyle({ textOverflow: 'ellipsis', overflow: 'hidden' });
  });

  it('opens the last run from a row action', async () => {
    const { onOpenSession } = renderScheduleTab();

    const lastRunButton = await screen.findByRole('button', { name: /view last run/i });
    fireEvent.click(lastRunButton);

    await waitFor(() => {
      expect(onOpenSession).toHaveBeenCalledWith('018f0000-0000-7000-8000-0000000000aa');
    });
  });

  it.each([
    ['self-owned before user-map hydration', 'owner', undefined, 'owner'],
    ['different owner before user-map hydration', 'caller', undefined, null],
    ['different owner after user-map hydration', 'caller', 'owner', 'owner'],
  ])('passes %s to the editor', async (_label, callerId, hydratedOwnerId, expectedOwnerId) => {
    const caller = { user_id: callerId, email: `${callerId}@example.com` } as User;
    const owner = { user_id: 'owner', email: 'owner@example.com' } as User;
    renderScheduleTab({
      schedules: [makeSchedule({ created_by: owner.user_id })],
      currentUser: caller,
      userById: hydratedOwnerId ? new Map([[hydratedOwnerId, owner]]) : undefined,
    });

    fireEvent.click(await screen.findByRole('button', { name: /edit schedule/i }));

    expect(scheduleFormProps.mock.lastCall?.[0]).toMatchObject({
      executionOwner: expectedOwnerId ? owner : null,
    });
  });

  it('keeps a different-owner editor fail-closed for stale or caller-only user state', async () => {
    const caller = { user_id: 'caller', email: 'caller@example.com' } as User;
    const staleOwner = { user_id: 'stale-owner', email: 'stale@example.com' } as User;
    renderScheduleTab({
      schedules: [makeSchedule({ created_by: 'owner' })],
      currentUser: caller,
      userById: new Map([
        ['caller', caller],
        ['owner', staleOwner],
      ]),
    });

    fireEvent.click(await screen.findByRole('button', { name: /edit schedule/i }));

    expect(scheduleFormProps.mock.lastCall?.[0]).toMatchObject({ executionOwner: null });
  });
});

describe('ScheduleTab in-place editor', () => {
  beforeEach(() => scheduleFormProps.mockClear());

  it('creates in place of the list, with a Schedules sub-header and no dialog', async () => {
    renderScheduleTab();
    await screen.findByRole('columnheader', { name: 'Title' });
    fireEvent.click(screen.getByRole('button', { name: /New$/ }));

    expect(screen.getByTestId('schedule-form')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Title' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(scheduleFormProps.mock.lastCall?.[0]).toMatchObject({ schedule: null });

    fireEvent.click(screen.getByRole('button', { name: 'Close form' }));
    expect(await screen.findByRole('columnheader', { name: 'Title' })).toBeInTheDocument();
  });

  it('edits in place', async () => {
    const schedule = makeSchedule({ name: 'Daily digest' });
    renderScheduleTab({ schedules: [schedule] });
    fireEvent.click(await screen.findByRole('button', { name: /edit schedule/i }));

    expect(screen.getByTestId('schedule-form')).toBeInTheDocument();
    expect(scheduleFormProps.mock.lastCall?.[0]).toMatchObject({ schedule });
  });

  it('hands the open form its draft reporter for the branch editor', async () => {
    const onDraftChange = vi.fn();
    renderScheduleTab({ onDraftChange });
    await screen.findByRole('columnheader', { name: 'Title' });
    fireEvent.click(screen.getByRole('button', { name: /New$/ }));
    expect(scheduleFormProps.mock.lastCall?.[0]).toMatchObject({ onDraftChange });
  });
});

describe('ScheduleTab on a phone', () => {
  afterEach(() => {
    media.compact = false;
  });

  it('lists schedules as cards with every row action reachable (no clipped table)', async () => {
    media.compact = true;
    renderScheduleTab({ schedules: [makeSchedule({ name: 'Daily digest' })] });
    expect(await screen.findByLabelText('Edit schedule Daily digest')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    for (const action of ['Run schedule', 'View runs for schedule', 'Delete schedule']) {
      expect(screen.getByLabelText(new RegExp(`^${action} Daily digest`))).toBeInTheDocument();
    }
  });
});

describe('ScheduleTab failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a load failure in place with Try again', async () => {
    const find = vi
      .fn()
      .mockRejectedValueOnce(new Error('Internal Server Error'))
      .mockResolvedValue({ data: [makeSchedule()] });
    renderScheduleTab({ overrides: { find } });

    expect(await screen.findByText("Couldn't load schedules.")).toBeInTheDocument();
    expect(screen.queryByText(/No schedules yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByLabelText(/schedule title:/i)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load schedules.")).not.toBeInTheDocument();
    expect(messageMocks.showError).not.toHaveBeenCalled();
  });

  it('explains a Run now rejection with the shared run reasons', async () => {
    const create = vi.fn(async () => {
      throw new Error('Schedule is disabled. Enable it before running manually.');
    });
    renderScheduleTab({ overrides: { create } });

    fireEvent.click(await screen.findByRole('button', { name: /run schedule .* now/i }));

    await waitFor(() =>
      expect(messageMocks.showError).toHaveBeenCalledWith(
        "Couldn't start the scheduled run. (Schedule is disabled. Enable it before running manually.)"
      )
    );
  });

  it('treats a Run now connection drop as unconfirmed', async () => {
    const create = vi.fn(async () => {
      throw new Error('socket has been disconnected');
    });
    renderScheduleTab({ overrides: { create } });

    fireEvent.click(await screen.findByRole('button', { name: /run schedule .* now/i }));

    await waitFor(() =>
      expect(messageMocks.showError).toHaveBeenCalledWith(
        'The connection to Agor dropped before this was confirmed. Refresh to see if it went through before you try to start the scheduled run again. (socket has been disconnected)'
      )
    );
  });

  it('names the toggle direction when turning a schedule off fails', async () => {
    const patch = vi.fn(async () => {
      throw Object.assign(new Error('Forbidden'), { name: 'Forbidden', code: 403 });
    });
    renderScheduleTab({ overrides: { patch } });

    fireEvent.click(await screen.findByRole('switch', { name: /disable schedule/i }));

    await waitFor(() =>
      expect(messageMocks.showError).toHaveBeenCalledWith(
        "Couldn't turn the schedule off. You don't have permission to do this. (Forbidden)"
      )
    );
  });

  it('keeps the raw text when a delete rejection has no plain reason', async () => {
    const remove = vi.fn(async () => {
      throw new Error('Internal Server Error');
    });
    renderScheduleTab({ overrides: { remove } });

    fireEvent.click(await screen.findByRole('button', { name: /delete schedule/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(messageMocks.showError).toHaveBeenCalledWith(
        "Couldn't delete the schedule. (Internal Server Error)"
      )
    );
  });
});
