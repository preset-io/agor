import { describe, expect, it } from 'vitest';
import { getModelDisplayName } from './modelDisplay';

describe('getModelDisplayName', () => {
  it('renders single-segment versions without a minor', () => {
    expect(getModelDisplayName('claude-opus-5')).toBe('opus-5');
    expect(getModelDisplayName('claude-sonnet-5')).toBe('sonnet-5');
    expect(getModelDisplayName('claude-fable-5')).toBe('fable-5');
  });

  it('renders two-segment versions as major.minor', () => {
    expect(getModelDisplayName('claude-opus-4-8')).toBe('opus-4.8');
    expect(getModelDisplayName('claude-sonnet-4-6')).toBe('sonnet-4.6');
    expect(getModelDisplayName('claude-haiku-4-5')).toBe('haiku-4.5');
  });

  it('ignores trailing suffixes like [1m]', () => {
    expect(getModelDisplayName('claude-sonnet-4-5[1m]')).toBe('sonnet-4.5');
    expect(getModelDisplayName('claude-opus-5[1m]')).toBe('opus-5');
  });

  it('falls back to the bare family name when there are no version digits', () => {
    expect(getModelDisplayName('claude-opus')).toBe('opus');
    expect(getModelDisplayName('claude-sonnet')).toBe('sonnet');
  });

  it('passes through unknown families unchanged', () => {
    expect(getModelDisplayName('some-unknown-model-9')).toBe('some-unknown-model-9');
  });
});
