import type {
  AgenticAuthMethod,
  AgenticToolConfigField,
  AgenticToolName,
  ClaudeCredentialSource,
  UpdateUserInput,
} from '@agor-live/client';

export type CredentialPatchValue = string | null;

/**
 * Build the canonical per-user agentic-tool credential patch consumed by the
 * users service. Both onboarding and User Settings should go through this
 * shape so credentials land under the same encrypted `data.agentic_tools` blob.
 */
export function buildAgenticToolCredentialPatch(
  tool: AgenticToolName,
  field: AgenticToolConfigField,
  value: CredentialPatchValue
): Pick<UpdateUserInput, 'agentic_tools' | 'agentic_auth_methods' | 'agentic_credential_sources'> {
  let authMethod: AgenticAuthMethod | undefined;
  let credentialSource: ClaudeCredentialSource | undefined;
  if (value !== null && tool === 'claude-code') {
    if (field === 'CLAUDE_CODE_OAUTH_TOKEN') {
      authMethod = 'subscription';
      credentialSource = 'subscription_token';
    } else if (field !== 'ANTHROPIC_BASE_URL') {
      authMethod = 'api_key';
      credentialSource = 'api_key';
    }
  } else if (value !== null && tool === 'codex' && field === 'OPENAI_API_KEY') {
    authMethod = 'api_key';
  }
  return {
    agentic_tools: {
      [tool]: { [field]: value },
    } as UpdateUserInput['agentic_tools'],
    ...(authMethod ? { agentic_auth_methods: { [tool]: authMethod } } : {}),
    ...(credentialSource
      ? { agentic_credential_sources: { 'claude-code': credentialSource } }
      : {}),
  };
}
