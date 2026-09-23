import { describe, expect, it } from 'vitest';
import {
  type ChildCompletionContext,
  renderChildCompletionCallback,
} from './child-completion-template';

const context: ChildCompletionContext = {
  childSessionId: 'child',
  childSessionFullId: 'child-full',
  childSessionTitle: 'Child',
  childTaskId: 'task',
  childTaskFullId: 'task-full',
  parentSessionId: 'parent',
  callbackSessionId: 'parent',
  status: 'completed',
  completedAt: '2026-09-22T00:00:00.000Z',
  messageCount: 4,
};

describe('callback recorded tool count', () => {
  it.each([undefined, null])(
    'omits unknown counts (%s) instead of claiming zero',
    (recordedToolCount) => {
      const rendered = renderChildCompletionCallback({ ...context, recordedToolCount });
      expect(rendered).toContain('**Stats:** 4 messages');
      expect(rendered).not.toContain('tool calls');
    }
  );
  it.each([0, 3])('includes known counts including zero (%s)', (recordedToolCount) => {
    expect(renderChildCompletionCallback({ ...context, recordedToolCount })).toContain(
      `4 messages, ${recordedToolCount} tool calls`
    );
  });
  it('exposes the new template variable without an old-count alias', () => {
    expect(
      renderChildCompletionCallback(
        { ...context, recordedToolCount: 3 },
        '{{recordedToolCount}}/{{toolUseCount}}'
      )
    ).toBe('3/');
  });
});
