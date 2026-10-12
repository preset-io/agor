import { AGENTIC_TOOL_DISPLAY_NAMES } from '@agor/agentic-tools';
import type { Task } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { describeTurnOutcome, type TurnOutcomeCopy } from './describeTurnOutcome';
import fixtures from './describeTurnOutcome.production.fixtures.json';
import { turnOutcomeDetails } from './turnOutcomeDetails';

/**
 * Real failed, stopped and timed-out tasks, reduced to one example per distinct
 * shape: verbatim error_message plus the task fields the banner reads.
 */
interface ProductionFixture {
  example: string | null;
  status: string;
  tool: string;
  sdk_failure_reason: string | null;
  termination: string | null;
  cause: string | null;
  executor_connected: boolean;
  recorded_tool_count: number | null;
}

function toTask(fixture: ProductionFixture, index: number): Task {
  return {
    task_id: `production-${index}`,
    session_id: 'session',
    created_by: 'user',
    full_prompt: 'prompt',
    status: fixture.status,
    created_at: '2026-09-20T00:00:00.000Z',
    git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
    // The viewer's own typed prompt, so a run that never started may offer Try again.
    metadata: { source: 'agor' },
    ...(fixture.example !== null ? { error_message: fixture.example } : {}),
    ...(fixture.executor_connected ? { executor_connected_at: '2026-09-20T00:00:01.000Z' } : {}),
    ...(fixture.recorded_tool_count !== null
      ? { recorded_tool_count: fixture.recorded_tool_count }
      : {}),
    ...(fixture.sdk_failure_reason || fixture.termination
      ? {
          sdk_failure: {
            reason: fixture.sdk_failure_reason,
            detected_at: '',
            tool: fixture.tool,
            termination: fixture.termination,
          },
        }
      : {}),
    ...(fixture.cause ? { termination_request: { cause: fixture.cause, requested_at: '' } } : {}),
  } as unknown as Task;
}

type Expected = Pick<TurnOutcomeCopy, 'cause' | 'type' | 'message' | 'action'>;
const lost = (work = 'Any edits are kept.'): Expected => ({
  cause: 'lost_connection',
  type: 'error',
  message: `Lost connection to the agent. ${work}`,
  action: 'resume',
});
const neverStarted: Expected = {
  cause: 'never_started',
  type: 'error',
  message: "The agent couldn't start. No files changed.",
  action: 'retry',
};
const codexRejected: Expected = {
  cause: 'provider_rejected',
  type: 'error',
  message: "Codex couldn't finish this run. Any edits are kept.",
  action: 'resume',
};
const stopped: Expected = {
  cause: 'stopped',
  type: 'neutral',
  message: 'The agent was stopped. Any edits are kept.',
  action: undefined,
};
const restartUnconfirmed: Expected = {
  cause: 'restart_unconfirmed',
  type: 'warning',
  message: 'Agor restarted. The agent may still be editing files.',
  action: undefined,
};
const unknown = (work: string): Expected => ({
  cause: 'unknown',
  type: 'error',
  message: `The agent hit a problem. ${work}`,
  action: 'resume',
});

const EXPECTED: Expected[] = [
  codexRejected,
  {
    cause: 'stopped_early',
    type: 'error',
    message: 'The agent stopped early. No files changed.',
    action: 'resume',
  },
  neverStarted,
  lost(),
  lost(),
  lost(),
  lost(),
  lost(),
  stopped,
  {
    cause: 'stopped_early',
    type: 'error',
    message: 'The agent stopped early. Any edits are kept.',
    action: 'resume',
  },
  codexRejected,
  unknown('Any edits are kept.'),
  stopped,
  {
    cause: 'not_connected',
    type: 'warning',
    message: "Claude Code isn't connected, so nothing ran.",
    action: 'settings',
  },
  stopped,
  lost(),
  lost(),
  restartUnconfirmed,
  restartUnconfirmed,
  stopped,
  unknown('No files changed.'),
  lost('No files changed.'),
  neverStarted,
  unknown('Any edits are kept.'),
  {
    cause: 'approval_timeout',
    type: 'warning',
    message: 'The agent stopped waiting for approval.',
    action: 'resume',
  },
];

describe('describeTurnOutcome on production error data', () => {
  const rows = (fixtures as ProductionFixture[]).map((fixture, index) => ({
    fixture,
    index,
    expected: EXPECTED[index],
  }));

  it('has one expectation per fixture', () => {
    expect(EXPECTED).toHaveLength(fixtures.length);
  });

  it.each(rows)('#$index $fixture.status $fixture.example', ({ fixture, index, expected }) => {
    const task = toTask(fixture, index);
    const agentName = (AGENTIC_TOOL_DISPLAY_NAMES as Record<string, string>)[fixture.tool];
    const outcome = describeTurnOutcome(task, { agentName, currentUserId: 'user' });
    const { action, ...shape } = expected;
    expect(outcome).toMatchObject(shape);
    expect(outcome?.action).toBe(action);

    // Every outcome keeps its technical facts reachable behind Details.
    const details = turnOutcomeDetails(task, { agenticTool: fixture.tool });
    expect(outcome?.type !== 'neutral' || details.hasSignal).toBe(true);
    if (fixture.example) {
      expect(details.rows).toContainEqual({ label: 'Error', value: fixture.example, code: true });
    }
  });

  it('explains an approval that expired before the timeout was recorded', () => {
    const index = fixtures.findIndex((fixture) => fixture.status === 'timed_out');
    expect(
      describeTurnOutcome(toTask(fixtures[index] as ProductionFixture, index))?.detailsLead
    ).toBe('Approval requests expire after a while.');
  });
});
