import { describe, expect, it } from 'vitest';
import { boardViewMoveForKey, moveBoardView } from './boardViews';

describe('moveBoardView', () => {
  it('moves a tab left or right among the shown tabs', () => {
    expect(moveBoardView(['board', 'chat', 'files'], 'chat', -1)).toEqual([
      'chat',
      'board',
      'files',
    ]);
    expect(moveBoardView(['chat', 'board', 'files'], 'chat', 1)).toEqual([
      'board',
      'chat',
      'files',
    ]);
  });

  it('does nothing past the ends', () => {
    expect(moveBoardView(['chat', 'board', 'files'], 'chat', -1)).toEqual([
      'chat',
      'board',
      'files',
    ]);
    expect(moveBoardView(['chat', 'board', 'files'], 'files', 1)).toEqual([
      'chat',
      'board',
      'files',
    ]);
  });

  it('moves Files like the other tabs', () => {
    expect(moveBoardView(['board', 'files', 'chat'], 'chat', -1)).toEqual([
      'board',
      'chat',
      'files',
    ]);
  });

  it('moves by more than one place for a drop', () => {
    expect(moveBoardView(['board', 'chat', 'files'], 'board', 5)).toEqual([
      'chat',
      'files',
      'board',
    ]);
  });
});

describe('boardViewMoveForKey', () => {
  it('maps Alt + Left and Alt + Right to a move', () => {
    expect(boardViewMoveForKey({ altKey: true, key: 'ArrowLeft' })).toBe(-1);
    expect(boardViewMoveForKey({ altKey: true, key: 'ArrowRight' })).toBe(1);
  });

  it('ignores plain arrows and other keys', () => {
    expect(boardViewMoveForKey({ altKey: false, key: 'ArrowRight' })).toBeNull();
    expect(boardViewMoveForKey({ altKey: true, key: 'Enter' })).toBeNull();
  });
});
