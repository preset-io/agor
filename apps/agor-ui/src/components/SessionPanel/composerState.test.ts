import { describe, expect, it } from 'vitest';
import {
  getComposerCircleState,
  isPermissionNonDefault,
  moveQueuedTask,
  splitPinnedActions,
} from './composerState';

describe('getComposerCircleState', () => {
  it('sends when idle, with or without text', () => {
    expect(
      getComposerCircleState({ stopAvailable: false, isRunning: false, hasInput: false })
    ).toBe('send');
    expect(getComposerCircleState({ stopAvailable: false, isRunning: false, hasInput: true })).toBe(
      'send'
    );
  });

  it('stops while running with an empty box', () => {
    expect(getComposerCircleState({ stopAvailable: true, isRunning: true, hasInput: false })).toBe(
      'stop'
    );
  });

  it('queues while running with text', () => {
    expect(getComposerCircleState({ stopAvailable: true, isRunning: true, hasInput: true })).toBe(
      'queue'
    );
  });

  it('stays Stop while a stop request settles and the box is empty', () => {
    expect(getComposerCircleState({ stopAvailable: true, isRunning: false, hasInput: false })).toBe(
      'stop'
    );
  });
});

describe('isPermissionNonDefault', () => {
  it('hides the chip for each tool default', () => {
    expect(isPermissionNonDefault('claude-code', 'auto')).toBe(false);
    expect(isPermissionNonDefault('gemini', 'autoEdit')).toBe(false);
    expect(isPermissionNonDefault('copilot', 'acceptEdits')).toBe(false);
    expect(isPermissionNonDefault('cursor', 'bypassPermissions')).toBe(false);
  });

  it('shows the chip for any other mode', () => {
    expect(isPermissionNonDefault('claude-code', 'plan')).toBe(true);
    expect(isPermissionNonDefault('claude-code', 'bypassPermissions')).toBe(true);
    expect(isPermissionNonDefault('gemini', 'yolo')).toBe(true);
  });

  it('compares Codex sandbox and approval with the default mapping', () => {
    const codex = (sandboxMode: string, approvalPolicy: string) =>
      isPermissionNonDefault('codex', 'allow-all', {
        sandboxMode: sandboxMode as never,
        approvalPolicy: approvalPolicy as never,
      });
    expect(codex('workspace-write', 'never')).toBe(false);
    expect(codex('read-only', 'untrusted')).toBe(true);
    expect(codex('workspace-write', 'on-request')).toBe(true);
  });
});

describe('splitPinnedActions', () => {
  it('follows the "+" menu order and drops actions the tool lacks', () => {
    expect(splitPinnedActions(['fork', 'spawn', 'upload'], ['upload', 'fork'])).toEqual({
      row: ['upload', 'fork'],
      folded: [],
    });
  });

  it('folds pins past the limit back into the menu', () => {
    expect(
      splitPinnedActions(['btw-fork', 'fork', 'upload'], ['upload', 'fork', 'btw-fork'], 2)
    ).toEqual({ row: ['upload', 'fork'], folded: ['btw-fork'] });
  });
});

describe('moveQueuedTask', () => {
  const order = ['a', 'b', 'c'];

  it('moves up, down and to the front', () => {
    expect(moveQueuedTask(order, 'b', 'up')).toEqual(['b', 'a', 'c']);
    expect(moveQueuedTask(order, 'b', 'down')).toEqual(['a', 'c', 'b']);
    expect(moveQueuedTask(order, 'c', 'front')).toEqual(['c', 'a', 'b']);
  });

  it('returns null at the edges or for an unknown task', () => {
    expect(moveQueuedTask(order, 'a', 'up')).toBeNull();
    expect(moveQueuedTask(order, 'c', 'down')).toBeNull();
    expect(moveQueuedTask(order, 'a', 'front')).toBeNull();
    expect(moveQueuedTask(order, 'x', 'up')).toBeNull();
  });
});
