import { describe, expect, it } from 'vitest';
import { isClaudeSubscriptionOAuthEnabled } from './claude-subscription-oauth';
import { getDefaultConfig } from './config-manager';

describe('isClaudeSubscriptionOAuthEnabled', () => {
  it('enables omitted configuration, including generated defaults', () => {
    expect(isClaudeSubscriptionOAuthEnabled({})).toBe(true);
    expect(isClaudeSubscriptionOAuthEnabled({ agentic_tools: {} })).toBe(true);
    expect(isClaudeSubscriptionOAuthEnabled(getDefaultConfig())).toBe(true);
  });

  it('preserves explicit opt-out and opt-in', () => {
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
