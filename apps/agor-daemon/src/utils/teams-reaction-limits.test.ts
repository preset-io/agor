import { describe, expect, it } from 'vitest';
import { TeamsReactionLimiter } from './teams-reaction-limits';

describe('TeamsReactionLimiter', () => {
  it('admits one prompt per reaction per minute and three per thread', () => {
    let now = 1_000;
    const limiter = new TeamsReactionLimiter(() => now);
    expect(limiter.admit('like:m1', 't1')).not.toBeNull();
    expect(limiter.admit('like:m1', 't1')).toBeNull();
    expect(limiter.admit('heart:m1', 't1')).not.toBeNull();
    expect(limiter.admit('laugh:m1', 't1')).not.toBeNull();
    expect(limiter.admit('sad:m1', 't1')).toBeNull();
    expect(limiter.admit('sad:m1', 't2')).not.toBeNull();
    now += 60_001;
    expect(limiter.admit('like:m1', 't1')).not.toBeNull();
  });

  it('releases a reaction that was not admitted so a redelivery is not throttled', () => {
    const limiter = new TeamsReactionLimiter(() => 5_000);
    limiter.admit('like:m1', 't1')?.release();
    expect(limiter.admit('like:m1', 't1')).not.toBeNull();
  });
});
