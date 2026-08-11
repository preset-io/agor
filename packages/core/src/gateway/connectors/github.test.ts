import { describe, expect, it } from 'vitest';
import { classifyGitHubInstallationError, githubIssueCommentProviderEventId } from './github';

describe('classifyGitHubInstallationError', () => {
  it('keeps an ordinary permission 403 permanent', () => {
    expect(classifyGitHubInstallationError({ status: 403 })).toMatchObject({
      code: 'github_credentials_invalid',
      kind: 'permanent',
    });
  });

  it.each([
    { response: { headers: { 'retry-after': '60' } } },
    { response: { headers: { 'x-ratelimit-remaining': '0' } } },
    {
      response: {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1234' },
      },
    },
    { response: { data: { message: 'You have exceeded a secondary rate limit.' } } },
  ])('keeps a rate-limited 403 transient', (detail) => {
    expect(classifyGitHubInstallationError({ status: 403, ...detail })).toMatchObject({
      code: 'github_api_unavailable',
      kind: 'transient',
    });
  });

  it('does not treat a reset header with remaining capacity as rate limited', () => {
    expect(
      classifyGitHubInstallationError({
        status: 403,
        response: {
          headers: { 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '1234' },
        },
      })
    ).toMatchObject({ code: 'github_credentials_invalid', kind: 'permanent' });
  });
});

describe('githubIssueCommentProviderEventId', () => {
  it('uses the provider-stable node id when available', () => {
    expect(githubIssueCommentProviderEventId({ id: 42, node_id: 'IC_kwDOstable' })).toBe(
      'github:issue_comment:IC_kwDOstable'
    );
  });

  it('falls back to the globally assigned numeric comment id', () => {
    expect(githubIssueCommentProviderEventId({ id: 42 })).toBe('github:issue_comment:42');
  });
});
