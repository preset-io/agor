import type { AgorClient, Branch, Repo, Schedule } from '@agor-live/client';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { App } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { BranchModal } from './BranchModal';

type Handler = (schedule: Schedule) => void;

function makeSchedule(overrides: Partial<Schedule>): Schedule {
  return {
    schedule_id: 'schedule-1',
    branch_id: 'branch-1',
    name: 'Schedule',
    cron_expression: '0 9 * * *',
    enabled: true,
    created_by: 'user-1',
    created_at: 1,
    updated_at: 1,
    prompt: 'Run this',
    model_config: {},
    last_run_at: null,
    last_run_session_id: null,
    next_run_at: null,
    ...overrides,
  } as unknown as Schedule;
}

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'branch-1',
    repo_id: 'repo-1',
    name: 'feature/counts',
    ref: 'feature/counts',
    path: '/tmp/repo/feature-counts',
    created_at: 1,
    updated_at: 1,
    archived: false,
    mcp_server_ids: [],
    ...overrides,
  } as unknown as Branch;
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repo_id: 'repo-1',
    slug: 'org/repo',
    name: 'repo',
    default_branch: 'main',
    repo_type: 'remote',
    remote_url: 'https://github.com/org/repo.git',
    local_path: '/tmp/repo',
    ...overrides,
  } as unknown as Repo;
}

function makeClient(initialSchedules: Schedule[]) {
  const handlers = new Map<string, Set<Handler>>();
  const scheduleService = {
    find: vi.fn(async () => ({ data: initialSchedules })),
    on: vi.fn((event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
    }),
    off: vi.fn((event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
    }),
    patch: vi.fn(),
    remove: vi.fn(),
  };
  const ownersService = {
    find: vi.fn(async () => {
      const error = new Error('not found') as Error & { code: number };
      error.code = 404;
      throw error;
    }),
  };
  const client = {
    service: vi.fn((name: string) => {
      if (name === 'schedules') return scheduleService;
      if (name === 'branches/:id/owners') return ownersService;
      return {};
    }),
  } as unknown as AgorClient;

  const emitSchedule = (event: string, schedule: Schedule) => {
    for (const handler of handlers.get(event) ?? []) {
      handler(schedule);
    }
  };

  return { client, scheduleService, emitSchedule };
}

describe('BranchModal schedule tab count', () => {
  it('uses the same branch schedule list for the Schedules tab badge and table', async () => {
    const schedules = [
      makeSchedule({ schedule_id: 'schedule-1', name: 'Morning summary', created_at: 2 }),
      makeSchedule({ schedule_id: 'schedule-2', name: 'Weekly retro', created_at: 1 }),
    ];
    const { client, scheduleService, emitSchedule } = makeClient(schedules);

    render(
      <App>
        <BranchModal
          open
          defaultTab="schedule"
          onClose={vi.fn()}
          branch={makeBranch()}
          repo={makeRepo()}
          sessions={[]}
          client={client}
        />
      </App>
    );

    await waitFor(() => {
      expect(scheduleService.find).toHaveBeenCalledWith({
        query: { branch_id: 'branch-1', $sort: { created_at: -1 } },
      });
    });

    await waitFor(() => {
      const schedulesTab = screen.getByRole('tab', { name: /Schedules/i });
      expect(within(schedulesTab).getByText('2')).toBeInTheDocument();
      expect(screen.getByText('Morning summary')).toBeInTheDocument();
      expect(screen.getByText('Weekly retro')).toBeInTheDocument();
    });

    act(() => {
      emitSchedule(
        'created',
        makeSchedule({
          schedule_id: 'other-branch-schedule',
          branch_id: 'branch-2',
          name: 'Other branch schedule',
        })
      );
    });

    expect(screen.queryByText('Other branch schedule')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('tab', { name: /Schedules/i })).getByText('2')
    ).toBeInTheDocument();

    act(() => {
      emitSchedule(
        'created',
        makeSchedule({
          schedule_id: 'schedule-3',
          branch_id: 'branch-1',
          name: 'Hourly heartbeat',
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Hourly heartbeat')).toBeInTheDocument();
      expect(
        within(screen.getByRole('tab', { name: /Schedules/i })).getByText('3')
      ).toBeInTheDocument();
    });
  });
});
