import { describe, expect, it } from 'vitest';
import {
  isClaudeSubscriptionOAuthEnabled,
  resolveClaudeOAuthCapability,
} from './claude-subscription-oauth';

describe('isClaudeSubscriptionOAuthEnabled', () => {
  it('defaults on while preserving explicit opt-out', () => {
    expect(isClaudeSubscriptionOAuthEnabled({})).toBe(true);
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

describe('effective Claude OAuth storage capability', () => {
  const config = {
    execution: {
      unix_user_mode: 'delegated' as const,
      executor_command_template: '/reviewed-launcher {unix_user}',
      executor_storage: { user_home: 'persistent-per-user' as const },
      executor_response: {
        external_protocol: 'executor-response-v1' as const,
        origin_url: 'http://daemon-0.internal:3030',
      },
    },
  };
  const authority = { postgres: true, encryption: true, localIsolation: false };
  it('admits supported standalone PostgreSQL delegated mode without local masks or flock', () => {
    expect(resolveClaudeOAuthCapability(config, { mode: 'standalone' }, authority)).toEqual({
      available: true,
      storage: 'backend',
    });
  });
  it('explicit opt-out wins over a supported operational backend', () => {
    expect(
      resolveClaudeOAuthCapability(
        { ...config, agentic_tools: { claude_subscription_oauth: false } },
        { mode: 'standalone' },
        authority
      ).reason
    ).toBe('operator_disabled');
  });
  it.each(['postgres', 'encryption'] as const)('requires %s authority', (field) => {
    expect(
      resolveClaudeOAuthCapability(config, { mode: 'standalone' }, { ...authority, [field]: false })
        .reason
    ).toBe('durable_authority_unavailable');
  });
  it.each([
    undefined,
    { external_protocol: 'executor-response-v1' as const },
    { origin_url: 'https://daemon.test' },
    {
      external_protocol: 'executor-response-v1' as const,
      origin_url: 'https://secret@daemon.test',
    },
  ])('refuses incomplete/invalid response channels', (executor_response) => {
    expect(
      resolveClaudeOAuthCapability(
        { execution: { ...config.execution, executor_response } },
        { mode: 'standalone' },
        authority
      ).reason
    ).toBe('runtime_channel_unavailable');
  });
  it.each(['simple', 'sandbox'] as const)(
    'does not infer a backend from %s or multiUser',
    (unix_user_mode) => {
      expect(
        resolveClaudeOAuthCapability(
          { execution: { ...config.execution, unix_user_mode } },
          { mode: 'standalone' },
          authority
        ).available
      ).toBe(false);
    }
  );
});
