import type { AgorConfig } from './types';

/**
 * Provider-policy release boundary for daemon-driven Claude subscription OAuth.
 * Absence is intentionally false so upgrades cannot expose the flow.
 */
export function isClaudeSubscriptionOAuthEnabled(config: AgorConfig): boolean {
  return config.agentic_tools?.claude_subscription_oauth === true;
}
