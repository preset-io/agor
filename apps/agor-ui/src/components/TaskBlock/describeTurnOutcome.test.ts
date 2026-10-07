import {
  CODEX_LIFECYCLE_MESSAGES,
  DAEMON_RESTART_RELEASED_MESSAGE,
  EXECUTOR_LAUNCH_REFUSED_MESSAGE,
  missingScopedCredentialMessage,
  permissionTimeoutMessage,
  SAFE_MISSING_PROVIDER_RESULT_MESSAGE,
  SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
} from '@agor/core/types';
import { type Task, TaskStatus } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  describeTurnOutcome,
  EDITS_KEPT,
  formatDuration,
  type TurnOutcomeContext,
} from './describeTurnOutcome';

const CONNECTED = '2026-10-01T00:00:01.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'task-1',
    session_id: 'session-1',
    created_by: 'user-1',
    metadata: { source: 'agor' },
    full_prompt: 'Do the thing',
    status: TaskStatus.FAILED,
    created_at: '2026-10-01T00:00:00.000Z',
    executor_connected_at: CONNECTED,
    git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
    ...overrides,
  } as Task;
}

const sdkFailure = (overrides: Partial<NonNullable<Task['sdk_failure']>> = {}) =>
  ({
    reason: 'heartbeat_lost',
    detected_at: '',
    tool: 'claude-code',
    termination: 'verified',
    ...overrides,
  }) as Task['sdk_failure'];

const cause = (value: NonNullable<Task['termination_request']>['cause']) => ({
  termination_request: { cause: value, requested_at: '' },
});

// The viewer typed this turn's prompt unless a test says otherwise.
const describe3 = (overrides: Partial<Task>, context?: TurnOutcomeContext) =>
  describeTurnOutcome(task(overrides), { currentUserId: 'user-1', ...context });

const ENOENT_SYSTEM_PROMPT =
  "ENOENT: no such file or directory, open '/usr/lib/node_modules/agor-live/dist/core/templates/agor-system-prompt.md'";

const BANNED = /executor|daemon|heartbeat|socket|SDK|containment|force-fail|\btasks?\b|\bturns?\b/i;

describe('describeTurnOutcome v3', () => {
  it.each([TaskStatus.COMPLETED, TaskStatus.RUNNING, TaskStatus.QUEUED])(
    'says nothing for an ordinary %s run',
    (status) => {
      expect(describe3({ status })).toBeNull();
    }
  );

  it('1. approval timeout is amber, explains expiry in Details, and resumes', () => {
    expect(describe3({ status: TaskStatus.TIMED_OUT })).toEqual({
      cause: 'approval_timeout',
      type: 'warning',
      message: 'The agent stopped waiting for approval.',
      detailsLead: 'Approval requests expire after a while.',
      action: 'resume',
    });
  });

  it('1. names the configured approval timeout in human units', () => {
    const lead = (ms: number) =>
      describe3({ status: TaskStatus.TIMED_OUT, error_message: permissionTimeoutMessage(ms) })
        ?.detailsLead;
    expect(lead(600_000)).toBe('Approval requests expire after 10 minutes.');
    expect(lead(60_000)).toBe('Approval requests expire after 1 minute.');
    expect(lead(7_200_000)).toBe('Approval requests expire after 2 hours.');
    expect(lead(45_000)).toBe('Approval requests expire after 45 seconds.');
    expect(lead(90_000)).toBe('Approval requests expire after 90 seconds.');
    expect(lead(5_400_000)).toBe('Approval requests expire after 90 minutes.');
  });

  it('formats durations with the largest unit that divides evenly', () => {
    expect(formatDuration(1000)).toBe('1 second');
    expect(formatDuration(3_600_000)).toBe('1 hour');
  });

  it('2. a provider error result stopped early and resumes', () => {
    for (const error_message of [
      SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
      CODEX_LIFECYCLE_MESSAGES.completed_without_response,
    ]) {
      expect(describe3({ error_message, recorded_tool_count: 0 })).toEqual({
        cause: 'stopped_early',
        type: 'error',
        message: 'The agent stopped early. No files changed.',
        action: 'resume',
      });
      expect(describe3({ error_message, recorded_tool_count: 36 })?.message).toBe(
        `The agent stopped early. ${EDITS_KEPT}`
      );
    }
  });

  it.each([
    ['you', 'You stopped the agent.'],
    [{ name: 'Maxime' }, 'Maxime stopped the agent.'],
    [undefined, 'The agent was stopped.'],
  ] as const)('3. names who stopped it (%o)', (stoppedBy, lead) => {
    expect(describe3({ status: TaskStatus.STOPPED, ...cause('user_stop') }, { stoppedBy })).toEqual(
      { cause: 'stopped', type: 'neutral', message: `${lead} ${EDITS_KEPT}` }
    );
  });

  it('4. a verified restart, from the notice or the release text, is one amber Resume', () => {
    const restart = {
      cause: 'restart',
      type: 'warning',
      message: `Agor restarted during this run. ${EDITS_KEPT}`,
      action: 'resume',
    };
    expect(describe3({ sdk_failure: sdkFailure() }, { restarted: true })).toEqual(restart);
    expect(describe3(cause('heartbeat_lost'), { restarted: true })).toEqual(restart);
    expect(
      describe3({ error_message: 'socket has been disconnected' }, { restarted: true })
    ).toEqual(restart);
    expect(describe3({ error_message: DAEMON_RESTART_RELEASED_MESSAGE })).toEqual(restart);
  });

  // Startup attaches the notice to the latest turn of every orphaned session, even one that had already ended.
  it('4. a restart notice never hides the cause of a turn that ended for another reason', () => {
    const restarted = { restarted: true };
    expect(
      describe3(
        {
          status: TaskStatus.TIMED_OUT,
          error_message: permissionTimeoutMessage(600_000),
        },
        restarted
      )
    ).toEqual({
      cause: 'approval_timeout',
      type: 'warning',
      message: 'The agent stopped waiting for approval.',
      detailsLead: 'Approval requests expire after 10 minutes.',
      action: 'resume',
    });
    expect(describe3({ status: TaskStatus.STOPPED, ...cause('user_stop') }, restarted)).toEqual({
      cause: 'stopped',
      type: 'neutral',
      message: `The agent was stopped. ${EDITS_KEPT}`,
    });
    expect(describe3({ status: TaskStatus.STOPPED }, restarted)?.cause).toBe('stopped');
    expect(describe3(cause('authorization_revoked'), restarted)?.cause).toBe('access_changed');
    expect(
      describe3({ error_message: missingScopedCredentialMessage('codex') }, restarted)?.cause
    ).toBe('not_connected');
    expect(describe3(cause('sdk_health_failure'), restarted)?.cause).toBe('stalled');
    expect(
      describe3({ ...cause('startup_timeout'), executor_connected_at: undefined }, restarted)?.cause
    ).toBe('never_started');
    expect(describe3({ error_message: ENOENT_SYSTEM_PROMPT }, restarted)?.cause).toBe('unknown');
    expect(
      describe3(
        { status: TaskStatus.STOPPING, sdk_failure: sdkFailure({ termination: 'unverified' }) },
        restarted
      )?.cause
    ).toBe('stop_unconfirmed');
  });

  it('4b. an unconfirmed restart warns that files may still change, with no action', () => {
    expect(
      describe3({
        status: TaskStatus.STOPPED,
        error_message: DAEMON_RESTART_RELEASED_MESSAGE,
        sdk_failure: sdkFailure({ termination: 'unverified' }),
      })
    ).toEqual({
      cause: 'restart_unconfirmed',
      type: 'warning',
      message: 'Agor restarted. The agent may still be editing files.',
    });
  });

  it('5. losing contact after the agent connected resumes', () => {
    for (const overrides of [
      { sdk_failure: sdkFailure() },
      cause('heartbeat_lost'),
      { error_message: 'socket has been disconnected' },
      { error_message: 'unhandledRejection: socket has been disconnected' },
      { error_message: 'operation has timed out' },
      { error_message: SAFE_MISSING_PROVIDER_RESULT_MESSAGE },
      { error_message: CODEX_LIFECYCLE_MESSAGES.stream_interrupted },
      { error_message: CODEX_LIFECYCLE_MESSAGES.stream_ended_without_completion },
    ]) {
      expect(describe3(overrides)).toEqual({
        cause: 'lost_connection',
        type: 'error',
        message: `Lost connection to the agent. ${EDITS_KEPT}`,
        action: 'resume',
      });
    }
  });

  it('6. a run that never started is the only one offering Try again', () => {
    const neverStarted = {
      cause: 'never_started',
      type: 'error',
      message: "The agent couldn't start. No files changed.",
      action: 'retry',
    };
    expect(describe3({ sdk_failure: sdkFailure({ reason: 'startup_timeout' }) })).toEqual(
      neverStarted
    );
    expect(describe3(cause('startup_timeout'))).toEqual(neverStarted);
    expect(describe3({ error_message: CODEX_LIFECYCLE_MESSAGES.stream_start_failed })).toEqual(
      neverStarted
    );
    expect(describe3({ ...cause('heartbeat_lost'), executor_connected_at: undefined })).toEqual(
      neverStarted
    );
    // Recorded work proves it started even without a connect time.
    expect(
      describe3({
        ...cause('heartbeat_lost'),
        executor_connected_at: undefined,
        recorded_tool_count: 3,
      })?.cause
    ).toBe('lost_connection');
  });

  it('6. replays only a prompt the viewer typed; anything else resumes', () => {
    const startup = cause('startup_timeout');
    expect(describe3(startup)?.action).toBe('retry');
    for (const [overrides, context] of [
      [startup, { currentUserId: 'someone-else' }],
      [startup, { currentUserId: undefined }],
      [{ ...startup, metadata: { source: 'agor', is_agor_callback: true } }, {}],
      [{ ...startup, metadata: { source: 'agor', system_authored: true } }, {}],
      [{ ...startup, metadata: { source: 'gateway' } }, {}],
      [{ ...startup, metadata: undefined }, {}],
      [{ ...startup, full_prompt: '  ' }, {}],
    ] as const) {
      expect(describe3(overrides as Partial<Task>, context)).toEqual({
        cause: 'never_started',
        type: 'error',
        message: "The agent couldn't start. No files changed.",
        action: 'resume',
      });
    }
  });

  it('6b. a failure proven never to connect could not start; legacy rows prove nothing', () => {
    const launchFailure = {
      error_message: 'Database operation failed (25P01)',
      executor_connected_at: undefined,
      recorded_tool_count: 0,
    };
    expect(describe3(launchFailure)?.cause).toBe('never_started');
    // The creation date is not evidence: an install upgraded late has new rows without either field.
    expect(
      describe3({ ...launchFailure, recorded_tool_count: undefined, created_at: CONNECTED })
    ).toEqual({
      cause: 'unknown',
      type: 'error',
      message: `The agent hit a problem. ${EDITS_KEPT}`,
      action: 'resume',
    });
    expect(describe3({ ...launchFailure, recorded_tool_count: null })?.cause).toBe('unknown');
    expect(
      describe3({ ...launchFailure, error_message: missingScopedCredentialMessage('codex') })?.cause
    ).toBe('not_connected');
  });

  it('7. Codex rejecting the run names the agent and resumes', () => {
    expect(
      describe3({ error_message: CODEX_LIFECYCLE_MESSAGES.turn_failed }, { agentName: 'Codex' })
    ).toEqual({
      cause: 'provider_rejected',
      type: 'error',
      message: `Codex couldn't finish this run. ${EDITS_KEPT}`,
      action: 'resume',
    });
  });

  it('8. an unconfirmed stop says who can force-stop it, with no action', () => {
    expect(
      describe3({
        status: TaskStatus.STOPPING,
        sdk_failure: sdkFailure({ termination: 'unverified' }),
      })
    ).toEqual({
      cause: 'stop_unconfirmed',
      type: 'warning',
      message: 'The agent may not have stopped. Files may still change.',
      detailsLead: 'Only a branch owner or admin can force-stop it.',
    });
  });

  it('9. an access change is amber and offers no action', () => {
    expect(describe3(cause('authorization_revoked'))).toEqual({
      cause: 'access_changed',
      type: 'warning',
      message: 'Agor stopped the agent after an access change.',
    });
  });

  it('10. the usage limit shows only when it ended the run, with one short reset time', () => {
    const now = new Date(2026, 9, 5, 9);
    const at = (date: Date) => Math.floor(date.getTime() / 1000);
    const time = new Date(2026, 9, 5, 15).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    const day = new Date(2026, 9, 6).toLocaleDateString(undefined, { weekday: 'short' });
    const limited = (rateLimit: { resetsAt?: number }, overrides: Partial<Task> = {}) =>
      describe3(
        { error_message: SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE, ...overrides },
        {
          rateLimit,
          agentName: 'Claude Code',
          now,
        }
      );
    expect(limited({ resetsAt: at(new Date(2026, 9, 5, 15)) })).toEqual({
      cause: 'usage_limit',
      type: 'warning',
      message: `Claude Code usage limit reached. Try again after ${time}.`,
      showsResetTime: true,
    });
    expect(limited({ resetsAt: at(new Date(2026, 9, 6, 15)) })?.message).toBe(
      `Claude Code usage limit reached. Try again after ${day} ${time}.`
    );
    expect(limited({})?.message).toBe('Claude Code usage limit reached. Try again later.');
    expect(limited({})?.showsResetTime).toBeUndefined();
    expect(limited({}, { sdk_failure: sdkFailure() })?.cause).toBe('lost_connection');
    expect(limited({}, { sdk_failure: sdkFailure({ reason: 'startup_timeout' }) })?.cause).toBe(
      'never_started'
    );
  });

  it('10. resumes once the reset time has passed, and dates one beyond this week', () => {
    const now = new Date(2026, 9, 5, 9);
    const at = (date: Date) => Math.floor(date.getTime() / 1000);
    const limited = (resetsAt: number) =>
      describe3(
        { error_message: SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE },
        { rateLimit: { resetsAt }, now }
      );
    expect(limited(at(new Date(2026, 9, 5, 8)))).toEqual({
      cause: 'usage_limit',
      type: 'warning',
      message: 'Usage limit reached.',
      action: 'resume',
    });
    expect(limited(at(now))?.message).toBe('Usage limit reached.');
    const later = new Date(2026, 9, 20, 15);
    const time = later.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const date = later.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(limited(at(later))?.message).toBe(
      `Usage limit reached. Try again after ${date}, ${time}.`
    );
    const weekday = new Date(2026, 9, 10, 15).toLocaleDateString(undefined, { weekday: 'short' });
    expect(limited(at(new Date(2026, 9, 10, 15)))?.message).toBe(
      `Usage limit reached. Try again after ${weekday} ${time}.`
    );
  });

  it('11. not connected offers settings, and hides behind the Connect panel', () => {
    const error_message = missingScopedCredentialMessage('claude-code');
    expect(describe3({ error_message }, { agentName: 'Claude Code' })).toEqual({
      cause: 'not_connected',
      type: 'warning',
      message: "Claude Code isn't connected, so nothing ran.",
      action: 'settings',
    });
    expect(describe3({ error_message }, { missingCredential: true })).toBeNull();
  });

  it('12. a remote agent that has not connected yet is still starting', () => {
    expect(
      describe3({
        status: TaskStatus.DISPATCHING,
        executor_connected_at: undefined,
        error_message:
          'Remote executor has not connected within the configured startup window; still waiting.',
      })
    ).toEqual({
      cause: 'waiting_to_start',
      type: 'info',
      message: 'Waiting for the agent to start…',
    });
    expect(describe3({ status: TaskStatus.RUNNING, error_message: 'x' })?.message).toBe(
      'The agent hit a problem but is still working.'
    );
  });

  it('13. stopping is informational', () => {
    expect(describe3({ status: TaskStatus.STOPPING })).toEqual({
      cause: 'stopping',
      type: 'info',
      message: 'Stopping the agent…',
    });
  });

  it('14. a stall shows only when it is why the agent was stopped', () => {
    expect(describe3(cause('sdk_health_failure'))).toEqual({
      cause: 'stalled',
      type: 'error',
      message: `The agent stopped responding. ${EDITS_KEPT}`,
      action: 'resume',
    });
    expect(describe3({ sdk_failure: sdkFailure({ reason: 'progress_stalled' }) })?.cause).toBe(
      'unknown'
    );
  });

  it('15. anything else that failed is a generic problem with Resume', () => {
    expect(describe3({ error_message: ENOENT_SYSTEM_PROMPT })).toEqual({
      cause: 'unknown',
      type: 'error',
      message: `The agent hit a problem. ${EDITS_KEPT}`,
      action: 'resume',
    });
    expect(describe3({ status: TaskStatus.COMPLETED, error_message: 'warning' })).toBeNull();
  });

  describe('launch refused', () => {
    const refused = {
      cause: 'launch_refused',
      type: 'warning',
      message:
        "Your team has reached its limit of work running at once, so the agent didn't start. No files changed.",
    };
    // As the daemon settles it: verified, failed, never connected, no tools.
    const refusedTask = {
      status: TaskStatus.FAILED,
      error_message: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
      executor_connected_at: undefined,
      recorded_tool_count: 0,
    };

    it.each([
      ['sdk_failure.reason', { sdk_failure: sdkFailure({ reason: 'launch_refused' }) }],
      ['termination_request.cause', { ...cause('launch_refused') }],
      [
        'both',
        { ...cause('launch_refused'), sdk_failure: sdkFailure({ reason: 'launch_refused' }) },
      ],
    ])('is a warning with no action from %s, not never_started', (_label, fields) => {
      const copy = describe3({ ...refusedTask, ...fields });
      expect(copy).toEqual(refused);
      expect(copy).not.toHaveProperty('action');
      expect(copy).not.toHaveProperty('detailsLead');
    });

    it('wins over a restart notice and over a connected run', () => {
      const fields = { ...refusedTask, sdk_failure: sdkFailure({ reason: 'launch_refused' }) };
      expect(describe3(fields, { restarted: true })).toEqual(refused);
      expect(describe3({ ...fields, executor_connected_at: CONNECTED })).toEqual(refused);
      expect(describe3({ ...fields, status: TaskStatus.TIMED_OUT })).toEqual(refused);
    });

    it('keeps never_started for a launch that was not refused', () => {
      expect(
        describe3({ ...refusedTask, ...cause('heartbeat_lost'), sdk_failure: sdkFailure() })?.cause
      ).toBe('never_started');
    });
  });

  it('writes every message as a full sentence free of internal vocabulary', () => {
    const errors = [
      '',
      'Executor heartbeat lost',
      DAEMON_RESTART_RELEASED_MESSAGE,
      SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
      ...Object.values(CODEX_LIFECYCLE_MESSAGES),
      missingScopedCredentialMessage('codex'),
    ];
    const statuses = Object.values(TaskStatus);
    const contexts: TurnOutcomeContext[] = [
      {},
      { rateLimit: {} },
      { agentName: 'Codex' },
      { restarted: true },
      { stoppedBy: 'you' },
      { stoppedBy: { name: 'Ada' } },
    ];
    const variants = (termination: 'verified' | 'unverified'): Partial<Task>[] => [
      { sdk_failure: sdkFailure({ termination }) },
      { sdk_failure: sdkFailure({ termination, reason: 'launch_refused' }) },
      { ...cause('launch_refused'), sdk_failure: sdkFailure({ termination }) },
    ];
    for (const error_message of [...errors, EXECUTOR_LAUNCH_REFUSED_MESSAGE]) {
      for (const status of statuses) {
        for (const termination of ['verified', 'unverified'] as const) {
          for (const variant of variants(termination)) {
            for (const context of contexts) {
              const copy = describe3({ status, error_message, ...variant }, context);
              if (!copy) continue;
              expect(copy.message).not.toMatch(BANNED);
              expect(copy.message).toMatch(/^[A-Z].*[.…]$/);
              if (copy.detailsLead) expect(copy.detailsLead).not.toMatch(BANNED);
            }
          }
        }
      }
    }
  });

  // Exact producer strings, with the fields each producer stores alongside them.
  const connected = { executor_connected_at: CONNECTED };
  const lost = { ...cause('heartbeat_lost'), sdk_failure: sdkFailure() };
  it.each([
    ['socket has been disconnected', {}, 'lost_connection', 'error', 'resume'],
    ['unhandledRejection: socket has been disconnected', {}, 'lost_connection', 'error', 'resume'],
    ['operation has timed out', {}, 'lost_connection', 'error', 'resume'],
    ['Executor exited unexpectedly with code 1.', lost, 'lost_connection', 'error', 'resume'],
    ['Executor exited unexpectedly with code unknown.', lost, 'lost_connection', 'error', 'resume'],
    [
      'Executor heartbeat lost; the executor may have crashed or disconnected.',
      lost,
      'lost_connection',
      'error',
      'resume',
    ],
    [
      'Codex failed the turn. Retry the prompt; review Codex authentication or runtime status if it continues.',
      {},
      'provider_rejected',
      'error',
      'resume',
    ],
    [
      'The Codex turn was interrupted before completion. Retry the prompt.',
      {},
      'lost_connection',
      'error',
      'resume',
    ],
    [
      'Agor could not confirm a successful response. Review any output and tool activity before retrying.',
      {},
      'stopped_early',
      'error',
      'resume',
    ],
    [
      'Agor could not confirm a successful response. Review any output and tool activity before retrying. Provider detail: error_max_turns',
      {},
      'stopped_early',
      'error',
      'resume',
    ],
    [
      'The Claude Code stream closed without a final result. Completion could not be confirmed. Review any output and tool activity before retrying.',
      {},
      'lost_connection',
      'error',
      'resume',
    ],
    [
      'The MCP operation failed. Retry, then ask an administrator to review the secure operational event if it continues.',
      {},
      'unknown',
      'error',
      'resume',
    ],
    [
      'Daemon restart released this Task without verifying executor termination.',
      { status: TaskStatus.STOPPED, sdk_failure: sdkFailure({ termination: 'unverified' }) },
      'restart_unconfirmed',
      'warning',
      undefined,
    ],
    [
      'Local executor did not connect before the startup deadline.',
      {
        ...cause('startup_timeout'),
        sdk_failure: sdkFailure({ reason: 'startup_timeout' }),
        executor_connected_at: undefined,
      },
      'never_started',
      'error',
      'retry',
    ],
    [
      'No scoped claude-code credential is configured for this workspace or user.',
      {},
      'not_connected',
      'warning',
      'settings',
    ],
    [
      'Codex subscription credentials are missing or unsafe to mount. Reconnect Codex in Agent Setup or use an API key.',
      {},
      'not_connected',
      'warning',
      'settings',
    ],
    [
      'The provider ended the request without returning a model response. Retry the prompt.',
      {},
      'stopped_early',
      'error',
      'resume',
    ],
    [
      'Force-failed by an authorized user; executor termination remains unverified.',
      { sdk_failure: sdkFailure({ termination: 'unverified' }) },
      'stop_unconfirmed',
      'warning',
      undefined,
    ],
    [ENOENT_SYSTEM_PROMPT, {}, 'unknown', 'error', 'resume'],
  ] as const)('real error string %s → %s', (error_message, fields, expectedCause, type, action) => {
    const copy = describe3({ ...connected, ...fields, error_message } as Partial<Task>);
    expect(copy).toMatchObject({ cause: expectedCause, type });
    expect(copy?.action).toBe(action);
  });
});
