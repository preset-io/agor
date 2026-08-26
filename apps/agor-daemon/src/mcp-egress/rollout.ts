import type { MCPEgressGatewayMode } from '@agor/core/types';

export type MCPEgressRolloutViolation =
  | 'raw_secret_downgrade_acknowledgement_required'
  | 'legacy_executor_fence_attestation_required';

export function validateMCPEgressRolloutChange(input: {
  currentMode: MCPEgressGatewayMode;
  nextMode: MCPEgressGatewayMode;
  acknowledgeRawSecretDowngrade: boolean;
  verifiedLegacyExecutorsFenced: boolean;
}): MCPEgressRolloutViolation | undefined {
  if (
    (input.currentMode === 'compatibility' || input.currentMode === 'enforced') &&
    (input.nextMode === 'off' || input.nextMode === 'observe') &&
    !input.acknowledgeRawSecretDowngrade
  ) {
    return 'raw_secret_downgrade_acknowledgement_required';
  }
  if (
    input.nextMode === 'enforced' &&
    input.currentMode !== 'enforced' &&
    !input.verifiedLegacyExecutorsFenced
  ) {
    return 'legacy_executor_fence_attestation_required';
  }
  return undefined;
}
