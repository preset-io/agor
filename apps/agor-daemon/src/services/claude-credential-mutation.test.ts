import { describe, expect, it } from 'vitest';
import {
  CLAUDE_AUTH_TRUSTED_USER_MUTATION,
  createClaudeUserCredentialPatchCoordinator,
} from './claude-credential-mutation.js';

describe('Claude user credential mutation boundary', () => {
  const coordinator = createClaudeUserCredentialPatchCoordinator(
    { get: () => ({}), service: () => undefined } as never,
    {} as never,
    {} as never
  );

  it.each([
    ['auth method', { agentic_auth_methods: { 'claude-code': 'subscription' } }],
    ['Anthropic API key', { agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: 'secret' } } }],
    [
      'Anthropic auth token',
      { agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: 'secret' } } },
    ],
    [
      'pasted subscription token',
      { agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'secret' } } },
    ],
  ])('coordinates every external Claude %s mutation', (_label, data) => {
    expect(coordinator.applies(data, {} as never)).toBe(true);
  });

  it('does not serialize unrelated user or Claude preference changes', () => {
    expect(coordinator.applies({ agentic_auth_methods: { codex: 'subscription' } }, {})).toBe(
      false
    );
    expect(
      coordinator.applies(
        { agentic_tools: { 'claude-code': { DEFAULT_MODEL: 'claude-opus-4-1' } } },
        {}
      )
    ).toBe(false);
  });

  it('does not recursively acquire authority for the trusted OAuth/logout users patch', () => {
    expect(
      coordinator.applies({ agentic_auth_methods: { 'claude-code': 'subscription' } }, {
        [CLAUDE_AUTH_TRUSTED_USER_MUTATION]: true,
      } as never)
    ).toBe(false);
  });
});
