import { describe, expect, it } from 'vitest';
import { buildAgenticToolCredentialPatch } from './agenticToolCredentials';

describe('buildAgenticToolCredentialPatch', () => {
  it('uses the same canonical storage path for onboarding and User Settings Claude subscription tokens', () => {
    const onboardingPatch = buildAgenticToolCredentialPatch(
      'claude-code',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'sk-ant-oat01-test'
    );
    const settingsPatch = buildAgenticToolCredentialPatch(
      'claude-code',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'sk-ant-oat01-test'
    );

    expect(onboardingPatch).toEqual(settingsPatch);
    expect(onboardingPatch).toEqual({
      agentic_tools: {
        'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
      },
      agentic_auth_methods: { 'claude-code': 'subscription' },
      agentic_credential_sources: { 'claude-code': 'subscription_token' },
    });
  });

  it('flips the Codex method to api_key when an OpenAI key is saved (the only deliberate api_key act)', () => {
    expect(buildAgenticToolCredentialPatch('codex', 'OPENAI_API_KEY', 'sk-proj-test')).toEqual({
      agentic_tools: {
        codex: { OPENAI_API_KEY: 'sk-proj-test' },
      },
      agentic_auth_methods: { codex: 'api_key' },
    });
  });

  it('does not flip the Codex method when only the base URL is set or a key is cleared', () => {
    // A non-credential field must not activate api_key…
    expect(buildAgenticToolCredentialPatch('codex', 'OPENAI_BASE_URL', 'https://gw')).toEqual({
      agentic_tools: { codex: { OPENAI_BASE_URL: 'https://gw' } },
    });
    // …and clearing the key must not assert any method (leaves the flip to a real save).
    expect(buildAgenticToolCredentialPatch('codex', 'OPENAI_API_KEY', null)).toEqual({
      agentic_tools: { codex: { OPENAI_API_KEY: null } },
    });
  });

  it('leaves the daemon to atomically derive a token-clear source transition', () => {
    expect(buildAgenticToolCredentialPatch('claude-code', 'CLAUDE_CODE_OAUTH_TOKEN', null)).toEqual(
      {
        agentic_tools: {
          'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null },
        },
      }
    );
  });

  it('does not assert a source when clearing either API credential field', () => {
    expect(buildAgenticToolCredentialPatch('claude-code', 'ANTHROPIC_API_KEY', null)).toEqual({
      agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: null } },
    });
    expect(buildAgenticToolCredentialPatch('claude-code', 'ANTHROPIC_AUTH_TOKEN', null)).toEqual({
      agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: null } },
    });
  });
});
