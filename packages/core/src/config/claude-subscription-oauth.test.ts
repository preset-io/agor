import { describe, expect, it } from 'vitest';
import { isClaudeSubscriptionOAuthEnabled } from './claude-subscription-oauth';

describe('isClaudeSubscriptionOAuthEnabled', () => {
  it('fails closed unless explicitly enabled', () => {
    expect(isClaudeSubscriptionOAuthEnabled({})).toBe(false);
    expect(
      isClaudeSubscriptionOAuthEnabled({
        agentic_tools: { claude_subscription_oauth: false },
      })
    ).toBe(false);
    expect(
      isClaudeSubscriptionOAuthEnabled({
        agentic_tools: { claude_subscription_oauth: true },
      })
    ).toBe(true);
  });
});
