import type { Session, Task } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { ownedScheduledCodexThread } from './scheduled-codex-retirement.js';

const thread = '00000000-0000-4000-8000-000000000001';
const session = {
  branch_id: 'branch-1',
  session_id: 'session-1',
  agentic_tool: 'codex',
  sdk_home_scope: 'branch',
  scheduled_from_branch: true,
  schedule_id: 'schedule-1',
  sdk_session_id: thread,
} as Session;
const proven = {
  session_id: session.session_id,
  status: 'completed',
  raw_sdk_response: { agor_created_thread: { id: thread, branch_id: session.branch_id } },
} as Task;

describe('scheduled Codex retirement ownership', () => {
  it('accepts creation provenance from the exact completed task', () => {
    expect(ownedScheduledCodexThread(session, [proven])).toBe(thread);
  });

  it('preserves unstamped, live, resumed, and foreign histories', () => {
    const cases = [
      { ...proven, raw_sdk_response: undefined },
      { ...proven, status: 'running' as Task['status'] },
      { ...proven, session_id: 'other' as Task['session_id'] },
      { ...proven, raw_sdk_response: { agor_created_thread: { id: thread, branch_id: 'other' } } },
    ];
    for (const task of cases) expect(ownedScheduledCodexThread(session, [task])).toBeUndefined();
    expect(
      ownedScheduledCodexThread({ ...session, scheduled_from_branch: false }, [proven])
    ).toBeUndefined();
    expect(
      ownedScheduledCodexThread({ ...session, sdk_home_scope: 'execution_home' }, [proven])
    ).toBeUndefined();
  });
});
