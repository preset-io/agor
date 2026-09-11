import type { AgorConfig } from './types';

/**
 * Deployment opt-out for daemon-driven Claude subscription OAuth.
 * Enabled by default; runtime containment and authorization gates still apply.
 */
export function isClaudeSubscriptionOAuthEnabled(config: AgorConfig): boolean {
  return config.agentic_tools?.claude_subscription_oauth !== false;
}
