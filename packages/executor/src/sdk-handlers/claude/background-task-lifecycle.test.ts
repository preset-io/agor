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
    ...(toolUseId && { tool_use_id: toolUseId }),
  });
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

  it.each([
    'completed',
    'failed',
    'stopped',
  ] as const)('allows a terminal continuation after a %s task notification', (status) => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('agent-1'));
    expect(lifecycle.observe(result()).resultDisposition).toBe('await-background-tasks');
    lifecycle.observe(settled('agent-1', status));
    expect(lifecycle.observe(result()).resultDisposition).toBe('terminal');
  });

  it.each([
    'completed',
    'failed',
    'stopped',
  ] as const)('settles a task from a terminal task_updated patch when no notification follows (%s)', (status) => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('bash-1'));
    expect(lifecycle.observe(updated('bash-1', status)).taskTransition).toBe('settled');
    expect(lifecycle.activeTaskCount).toBe(0);
    expect(lifecycle.observe(result()).resultDisposition).toBe('terminal');
  });

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

  it('settles active background tasks when permission_denied occurs', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('agent-1'));
    const transition = lifecycle.observe(
      message({
        type: 'system',
        subtype: 'permission_denied',
        agent_id: 'agent-1',
        tool_name: 'Bash',
        tool_use_id: 'toolu_abc',
        message: 'Command refused',
      })
    );
    expect(transition.taskTransition).toBe('settled');
    expect(lifecycle.activeTaskCount).toBe(0);
  });

  it('records the parent tool_use_id from task_started when present', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('agent-1', 'agent', 'toolu_parent_123'));
    expect(lifecycle.getParentToolUseId('agent-1')).toBe('toolu_parent_123');
  });

  it('returns undefined for a task_id with no parent tool_use_id in task_started', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('agent-1'));
    expect(lifecycle.getParentToolUseId('agent-1')).toBeUndefined();
  });

  it('returns undefined for an unknown task_id', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    expect(lifecycle.getParentToolUseId('unknown')).toBeUndefined();
  });

  it('provides the correct parent tool_use_id to correlate a subagent permission denial', () => {
    const lifecycle = new ClaudeBackgroundTaskLifecycle();
    lifecycle.observe(started('task-abc', 'agent', 'toolu_launch_agent'));
    lifecycle.observe(
      message({
        type: 'system',
        subtype: 'permission_denied',
        agent_id: 'task-abc',
        tool_name: 'Bash',
        tool_use_id: 'toolu_denied_tool',
        message: 'Denied',
      })
    );
    expect(lifecycle.getParentToolUseId('task-abc')).toBe('toolu_launch_agent');
    expect(lifecycle.activeTaskCount).toBe(0);
  });
});
