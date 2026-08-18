import type { SDKMessage } from '@agor/core/sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeBackgroundTaskLifecycle } from './background-task-lifecycle.js';

const message = (value: Record<string, unknown>) => value as SDKMessage;
const started = (taskId: string, taskType = 'agent', toolUseId?: string) =>
  message({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    task_type: taskType,
    tool_use_id: toolUseId,
  });
const settled = (taskId: string, status: 'completed' | 'failed' | 'stopped' = 'completed') =>
  message({ type: 'system', subtype: 'task_notification', task_id: taskId, status });
const updated = (taskId: string, status: string) =>
  message({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status } });
const result = (subtype = 'success') => message({ type: 'result', subtype });
/** An assistant turn that launched `toolUseIds`, either top-level or inside a subagent. */
const launches = (toolUseIds: string[], parentToolUseId: string | null) =>
  message({
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: {
      content: toolUseIds.map((id) => ({ type: 'tool_use', id, name: 'Task', input: {} })),
    },
  });

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

  // `task_updated.patch.status` and `task_notification.status` are different SDK
  // enums: only this one can report `killed`, and it can never report `stopped`.
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

  it.each(['pending', 'running', 'paused'] as const)(
    'keeps waiting through a non-terminal task_updated patch (%s)',
    (status) => {
      const lifecycle = new ClaudeBackgroundTaskLifecycle();
      lifecycle.observe(started('bash-1'));
      expect(lifecycle.observe(updated('bash-1', status)).taskTransition).toBeUndefined();
      expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
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
    expect(lifecycle.activeTaskIds).toEqual(['agent-1']);
    expect(lifecycle.clearActiveTasks()).toBe(1);
    expect(lifecycle.clearActiveTasks()).toBe(0);
    expect(lifecycle.activeTaskIds).toEqual([]);
  });

  it('waits for a task the top-level turn launched', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(launches(['tool-1'], null));
    expect(lifecycle.observe(started('agent-1', 'agent', 'tool-1')).taskTransition).toBe('started');
    expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
  });

  it('never waits for a task launched from inside a subagent', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(launches(['tool-1'], null));
    lifecycle.observe(started('agent-1', 'agent', 'tool-1'));
    // The subagent's own Task call is forwarded with parent_tool_use_id set.
    lifecycle.observe(launches(['tool-2'], 'tool-1'));
    expect(
      lifecycle.observe(started('nested-1', 'agent', 'tool-2')).taskTransition
    ).toBeUndefined();
    expect(lifecycle.activeTaskIds).toEqual(['agent-1']);
    lifecycle.observe(settled('agent-1'));
    expect(lifecycle.observe(result()).resultDisposition).toBe('terminal');
  });

  it('releases nested tasks announced before their launch site is forwarded', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    expect(lifecycle.observe(started('nested-1', 'agent', 'tool-2')).taskTransition).toBe(
      'started'
    );
    expect(lifecycle.observe(started('nested-2', 'agent', 'tool-3')).taskTransition).toBe(
      'started'
    );
    expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
    expect(lifecycle.observe(launches(['tool-2', 'tool-3'], 'tool-1'))).toMatchObject({
      taskTransition: 'settled',
      settledTaskCount: 2,
    });
    expect(lifecycle.observe(result()).resultDisposition).toBe('terminal');
  });
});
