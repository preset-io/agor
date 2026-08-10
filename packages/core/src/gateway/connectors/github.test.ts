import { describe, expect, it } from 'vitest';
import { githubIssueCommentProviderEventId } from './github';

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
