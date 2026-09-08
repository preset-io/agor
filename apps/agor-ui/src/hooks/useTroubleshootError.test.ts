import { describe, expect, it } from 'vitest';
import type { AgorState } from '../store/agorStore';
import {
  buildTroubleshootPrompt,
  type ErrorTroubleshootContext,
  resolveTarget,
} from './useTroubleshootError';

// Minimal store snapshot — resolveTarget only touches these four maps (and the
// real selectors it delegates to read the same ones).
function makeState(overrides: Partial<Record<string, unknown>> = {}): AgorState {
  return {
    branchById: new Map(),
    sessionById: new Map(),
    boardById: new Map(),
    boardObjectsByBoardId: new Map(),
    ...overrides,
  } as unknown as AgorState;
}

describe('resolveTarget', () => {
  it('prefers an explicit branch from context', () => {
    const state = makeState({
      branchById: new Map([['b1', { branch_id: 'b1', board_id: 'board1' }]]),
    });
    expect(resolveTarget({ branchId: 'b1' }, state)).toEqual({ branchId: 'b1', boardId: 'board1' });
  });

  it('resolves the branch from a session when no branch is given', () => {
    const state = makeState({
      sessionById: new Map([
        ['s1', { session_id: 's1', branch_id: 'b1', branch_board_id: 'board1' }],
      ]),
      branchById: new Map([['b1', { branch_id: 'b1', board_id: 'board1' }]]),
    });
    expect(resolveTarget({ sessionId: 's1' }, state)).toEqual({
      branchId: 'b1',
      boardId: 'board1',
    });
  });

  it('falls back to a branch on the given board when context is thin', () => {
    const state = makeState({
      branchById: new Map([['b1', { branch_id: 'b1', board_id: 'board1' }]]),
      boardById: new Map([['board1', { board_id: 'board1' }]]),
      boardObjectsByBoardId: new Map([['board1', [{ branch_id: 'b1' }]]]),
    });
    expect(resolveTarget({ boardId: 'board1' }, state)).toEqual({
      branchId: 'b1',
      boardId: 'board1',
    });
  });

  it('returns null when nothing can be resolved', () => {
    expect(resolveTarget({}, makeState())).toBeNull();
  });
});

describe('buildTroubleshootPrompt', () => {
  const target = { branchId: 'b1', boardId: 'board1' };

  it('embeds the error text in a fenced block', () => {
    const prompt = buildTroubleshootPrompt('Boom went wrong', {}, target);
    expect(prompt).toContain('## Error');
    expect(prompt).toContain('Boom went wrong');
    expect(prompt).toContain('- Branch: b1');
  });

  it('includes the context lines that are present', () => {
    const context: ErrorTroubleshootContext = {
      source: 'Sending a prompt',
      sessionId: 's1',
      boardId: 'board1',
      branchId: 'b1',
    };
    const prompt = buildTroubleshootPrompt('nope', context, target);
    expect(prompt).toContain('- Source: Sending a prompt');
    expect(prompt).toContain('- Session: s1');
    expect(prompt).toContain('- Board: board1');
    expect(prompt).toContain('- Branch: b1');
  });

  it('omits the stack block unless a stack is supplied', () => {
    expect(buildTroubleshootPrompt('x', {}, target)).not.toContain('## Stack');
    expect(buildTroubleshootPrompt('x', { stack: 'at foo()' }, target)).toContain('at foo()');
  });

  it('degrades to a placeholder when the error text is empty', () => {
    expect(buildTroubleshootPrompt('   ', {}, target)).toContain('(no message)');
  });
});
