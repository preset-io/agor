import { describe, expect, it } from 'vitest';
import { isPrivateTeammateFrameworkFork } from './branch';

describe('private teammate framework forks', () => {
  it('matches the fork names on slug or remote', () => {
    expect(
      isPrivateTeammateFrameworkFork({ slug: 'acme/agor-teammate-private', remote_url: undefined })
    ).toBe(true);
    expect(
      isPrivateTeammateFrameworkFork({
        slug: 'acme/assistant',
        remote_url: 'git@github.com:acme/agor-assistant-private.git',
      })
    ).toBe(true);
    expect(
      isPrivateTeammateFrameworkFork({ slug: 'preset-io/agor-teammate', remote_url: undefined })
    ).toBe(false);
  });
});
