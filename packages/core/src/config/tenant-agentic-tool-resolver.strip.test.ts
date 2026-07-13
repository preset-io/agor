import { describe, expect, it } from 'vitest';
import { stripProviderCredentialEnvironment } from './tenant-agentic-tool-resolver';

/**
 * Regression tests for the 2026-07-13 incident: the strip was tool-agnostic
 * and deleted user-configured env vars (GITHUB_TOKEN in particular) from
 * every session. The strip must remove ONLY the running tool's provider
 * surface so the policy-resolved connection is that SDK's sole credential.
 */
describe('stripProviderCredentialEnvironment', () => {
  const baseEnv = {
    PATH: '/usr/bin',
    MY_CUSTOM_VAR: 'hello',
    GITHUB_TOKEN: 'ghp_user',
    GH_TOKEN: 'ghp_alias',
    AWS_ACCESS_KEY_ID: 'AKIA...',
    AWS_SECRET_ACCESS_KEY: 'shh',
    GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
    GOOGLE_API_KEY: 'g-key',
    ANTHROPIC_API_KEY: 'user-anthropic',
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_VERTEX_PROJECT_ID: 'proj',
    OPENAI_API_KEY: 'user-openai',
    OPENAI_BASE_URL: 'https://openai.example',
    GEMINI_API_KEY: 'user-gemini',
    COPILOT_GITHUB_TOKEN: 'copilot-token',
    CURSOR_API_KEY: 'cursor-key',
    UNDEFINED_VAR: undefined,
  };

  it('claude-code strips its own provider surface but keeps generic dev credentials', () => {
    const result = stripProviderCredentialEnvironment(baseEnv, 'claude-code');

    // Own connection fields + ambient routing switches are gone
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(result).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(result).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(result).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
    expect(result).not.toHaveProperty('ANTHROPIC_VERTEX_PROJECT_ID');

    // User-configured generic credentials survive
    expect(result.GITHUB_TOKEN).toBe('ghp_user');
    expect(result.GH_TOKEN).toBe('ghp_alias');
    expect(result.AWS_ACCESS_KEY_ID).toBe('AKIA...');
    expect(result.AWS_SECRET_ACCESS_KEY).toBe('shh');
    expect(result.GOOGLE_APPLICATION_CREDENTIALS).toBe('/creds.json');
    expect(result.MY_CUSTOM_VAR).toBe('hello');

    // Other tools' credentials are not this tool's concern
    expect(result.OPENAI_API_KEY).toBe('user-openai');
    expect(result.GEMINI_API_KEY).toBe('user-gemini');
  });

  it('claude-code-cli canonicalizes to the claude-code surface', () => {
    const result = stripProviderCredentialEnvironment(baseEnv, 'claude-code-cli');
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(result.GITHUB_TOKEN).toBe('ghp_user');
  });

  it('codex strips only OpenAI fields', () => {
    const result = stripProviderCredentialEnvironment(baseEnv, 'codex');
    expect(result).not.toHaveProperty('OPENAI_API_KEY');
    expect(result).not.toHaveProperty('OPENAI_BASE_URL');
    expect(result.GITHUB_TOKEN).toBe('ghp_user');
    expect(result.ANTHROPIC_API_KEY).toBe('user-anthropic');
  });

  it('gemini strips its key plus Google ambient auth surface', () => {
    const result = stripProviderCredentialEnvironment(baseEnv, 'gemini');
    expect(result).not.toHaveProperty('GEMINI_API_KEY');
    expect(result).not.toHaveProperty('GOOGLE_API_KEY');
    expect(result).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    expect(result.GITHUB_TOKEN).toBe('ghp_user');
    expect(result.AWS_ACCESS_KEY_ID).toBe('AKIA...');
  });

  it('copilot strips GITHUB_TOKEN / GH_TOKEN ambient fallbacks', () => {
    const result = stripProviderCredentialEnvironment(baseEnv, 'copilot');
    expect(result).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
    expect(result).not.toHaveProperty('GITHUB_TOKEN');
    expect(result).not.toHaveProperty('GH_TOKEN');
    expect(result.ANTHROPIC_API_KEY).toBe('user-anthropic');
  });

  it('cursor strips only its own key', () => {
    const result = stripProviderCredentialEnvironment(baseEnv, 'cursor');
    expect(result).not.toHaveProperty('CURSOR_API_KEY');
    expect(result.GITHUB_TOKEN).toBe('ghp_user');
  });

  it('opencode (no provider connection) strips nothing', () => {
    const result = stripProviderCredentialEnvironment(baseEnv, 'opencode');
    expect(result.ANTHROPIC_API_KEY).toBe('user-anthropic');
    expect(result.GITHUB_TOKEN).toBe('ghp_user');
  });

  it('drops undefined values regardless of tool', () => {
    const result = stripProviderCredentialEnvironment(baseEnv, 'codex');
    expect(result).not.toHaveProperty('UNDEFINED_VAR');
  });
});
