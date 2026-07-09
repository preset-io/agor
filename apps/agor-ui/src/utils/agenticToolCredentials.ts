import type { AgenticToolConfigField, AgenticToolName, UpdateUserInput } from '@agor-live/client';

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
): Pick<UpdateUserInput, 'agentic_tools'> {
  return {
    agentic_tools: {
      [tool]: { [field]: value },
    } as UpdateUserInput['agentic_tools'],
  };
}
