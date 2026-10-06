import { type Task, TaskStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { taskRecoveryNotice } from './taskRecovery';

const task = {
  status: TaskStatus.STOPPING,
  termination_request: { cause: 'heartbeat_lost', requested_at: 'now' },
} as Task;
describe('user-facing recovery states', () => {
  it('explains automatic recovery without asking users to stop again', () => {
    const notice = taskRecoveryNotice(task)!;
    expect(notice.title).toContain('recovering');
    expect(notice.description).toContain('do not need to stop it again');
  });
  it('distinguishes user-requested Stop from a connection interruption', () => {
    expect(
      taskRecoveryNotice({
        ...task,
        termination_request: { ...task.termination_request!, cause: 'user_stop' },
      })?.title
    ).toBe('Stopping the previous work…');
  });
  it('does not describe failed cleanup as ongoing progress or confirmed death', () => {
    const notice = taskRecoveryNotice({
      ...task,
      sdk_failure: { termination: 'unverified' } as Task['sdk_failure'],
    })!;
    expect(notice.title).toBe('Cleanup needs attention');
    expect(notice.description).toContain('may still be changing files');
    expect(notice.description).not.toMatch(/quiescen|executor|containment|durable|promptable/);
  });
  it('does not imply that reopening stopped the old execution', () => {
    expect(
      taskRecoveryNotice({
        ...task,
        status: TaskStatus.FAILED,
        sdk_failure: { termination: 'unverified' } as Task['sdk_failure'],
      })?.description
    ).toContain('Reopening did not stop it');
  });
  it.each([TaskStatus.COMPLETED, TaskStatus.RUNNING, TaskStatus.QUEUED, TaskStatus.STOPPED])(
    'does not invent recovery for %s',
    (status) => {
      expect(taskRecoveryNotice({ ...task, status })).toBeNull();
    }
  );
});
