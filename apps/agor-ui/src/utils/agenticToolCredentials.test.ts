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
    });
  });

  it('clears a token by sending null at the same canonical field path', () => {
    expect(buildAgenticToolCredentialPatch('claude-code', 'CLAUDE_CODE_OAUTH_TOKEN', null)).toEqual(
      {
        agentic_tools: {
          'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null },
        },
      }
    );
  });
});
