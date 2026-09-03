import type { SDKMessage } from '@agor/core/sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeBackgroundTaskLifecycle } from './background-task-lifecycle.js';

const message = (value: Record<string, unknown>) => value as SDKMessage;
const started = (taskId: string, taskType = 'agent') =>
  message({ type: 'system', subtype: 'task_started', task_id: taskId, task_type: taskType });
const settled = (taskId: string, status: 'completed' | 'failed' | 'stopped' = 'completed') =>
  message({ type: 'system', subtype: 'task_notification', task_id: taskId, status });
const updated = (taskId: string, status: string) =>
  message({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status } });
const result = (subtype = 'success') => message({ type: 'result', subtype });

describe('ClaudeBackgroundTaskLifecycle', () => {
  it('keeps a Workflow alive across its parent result until its completion turn', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('workflow-1', 'local_workflow'));
    expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
    lifecycle.observe(settled('workflow-1'));
    expect(lifecycle.observe(result()).resultDisposition).toBe('terminal');
  });

  it('preserves the parent result while an Agent completion notification is pending', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('agent-1'));
    expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
    expect(lifecycle.activeTaskCount).toBe(1);
    lifecycle.observe(settled('agent-1'));
    expect(lifecycle.activeTaskCount).toBe(0);
  });

  it.each(['completed', 'failed', 'stopped'] as const)(
    'allows a terminal continuation after a %s task notification',
    (status) => {
      const lifecycle = new ClaudeBackgroundTaskLifecycle();
      lifecycle.observe(started('agent-1'));
      expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
      lifecycle.observe(settled('agent-1', status));
      expect(lifecycle.observe(result()).resultDisposition).toBe('terminal');
    }
  );

  // `killed` is task_updated-only (not a task_notification status) and must
  // still drain the task — otherwise a killed background task reported only via
  // task_updated would wait out the whole active-task timeout.
  it.each(['completed', 'failed', 'killed'] as const)(
    'settles a task from a terminal task_updated patch when no notification follows (%s)',
    (status) => {
      const lifecycle = new ClaudeBackgroundTaskLifecycle();
      lifecycle.observe(started('bash-1'));
      expect(lifecycle.observe(updated('bash-1', status)).taskTransition).toBe('settled');
      expect(lifecycle.activeTaskCount).toBe(0);
      expect(lifecycle.observe(result()).resultDisposition).toBe('terminal');
    }
  );

  it('deduplicates task_updated followed by task_notification and ignores non-terminal patches', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('bash-1'));
    expect(lifecycle.observe(updated('bash-1', 'running')).taskTransition).toBeUndefined();
    expect(lifecycle.activeTaskCount).toBe(1);
    expect(lifecycle.observe(updated('bash-1', 'completed')).taskTransition).toBe('settled');
    expect(lifecycle.observe(settled('bash-1')).taskTransition).toBeUndefined();
    expect(lifecycle.activeTaskCount).toBe(0);
  });

  it('waits for every background task before accepting a later result', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('agent-1'));
    lifecycle.observe(started('agent-2'));
    expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
    lifecycle.observe(settled('agent-1'));
    expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
    lifecycle.observe(settled('agent-2'));
    expect(lifecycle.observe(result()).resultDisposition).toBe('terminal');
  });

  it('ends ordinary turns immediately', () => {
    expect(new ClaudeBackgroundTaskLifecycle().observe(result()).resultDisposition).toBe(
      'terminal'
    );
  });

  it('ends error results even if a task never reports settlement', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('agent-1'));
    expect(lifecycle.observe(result('error_during_execution')).resultDisposition).toBe('terminal');
  });

  it('ignores duplicate and unknown settlement notifications', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('agent-1'));
    lifecycle.observe(settled('unknown'));
    lifecycle.observe(settled('agent-1'));
    lifecycle.observe(settled('agent-1'));
    expect(lifecycle.activeTaskCount).toBe(0);
    expect(lifecycle.observe(result()).resultDisposition).toBe('terminal');
  });

  it('ignores a matching notification with a missing or future status', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('agent-1'));
    expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
    lifecycle.observe(
      message({ type: 'system', subtype: 'task_notification', task_id: 'agent-1' })
    );
    lifecycle.observe(
      message({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-1',
        status: 'paused',
      })
    );
    expect(lifecycle.activeTaskCount).toBe(1);
    expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
  });

  it('reports only real task transitions and can clear orphaned activity', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    expect(lifecycle.observe(started('agent-1')).taskTransition).toBe('started');
    expect(lifecycle.observe(started('agent-1')).taskTransition).toBeUndefined();
    expect(lifecycle.observe(settled('unknown')).taskTransition).toBeUndefined();
    expect(lifecycle.clearActiveTasks()).toBe(1);
    expect(lifecycle.clearActiveTasks()).toBe(0);
  });
});
