import { describe, expect, it } from 'vitest';
import { formatElapsed, thinkingLabel, thoughtForLabel, workingStep } from './liveStatus';

describe('thinkingLabel', () => {
  it.each([
    [0, 'Thinking…'],
    [14.9, 'Thinking…'],
    [15, 'Still thinking…'],
    [29, 'Still thinking…'],
    [30, 'Thinking more…'],
    [45, 'Thinking some more…'],
    [59, 'Thinking some more…'],
    [60, 'Almost done thinking…'],
    [600, 'Almost done thinking…'],
  ])('at %ss reads %s', (seconds, label) => {
    expect(thinkingLabel(seconds)).toBe(label);
  });
});

describe('formatElapsed', () => {
  it.each([
    [0, '1s'],
    [0.4, '1s'],
    [12, '12s'],
    [59.9, '59s'],
    [60, '1m 0s'],
    [72, '1m 12s'],
    [3725, '1h 2m'],
  ])('%ss is %s', (seconds, text) => {
    expect(formatElapsed(seconds)).toBe(text);
  });
});

describe('thoughtForLabel', () => {
  it('names the duration, never 0s', () => {
    expect(thoughtForLabel(1_000, 13_000)).toBe('Thought for 12s');
    expect(thoughtForLabel(0, 72_000)).toBe('Thought for 1m 12s');
    expect(thoughtForLabel(0, 300)).toBe('Thought for 1s');
  });

  it('falls back when either timestamp is unknown', () => {
    expect(thoughtForLabel()).toBe('Thought for a while');
    expect(thoughtForLabel(1_000)).toBe('Thought for a while');
    expect(thoughtForLabel(5_000, 1_000)).toBe('Thought for a while');
  });
});

describe('workingStep', () => {
  it('names the ask, then the running tool, then falls back to working', () => {
    expect(workingStep({ awaiting: 'approval', tool: 'Bash' })).toBe('Waiting for approval · Bash');
    expect(workingStep({ awaiting: 'approval' })).toBe('Waiting for approval');
    expect(workingStep({ awaiting: 'input', tool: 'Bash' })).toBe('Asked a question');
    expect(workingStep({ tool: 'Bash' })).toBe('Running: Bash');
    expect(workingStep({})).toBe('Working…');
  });
});
