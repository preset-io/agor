import { describe, expect, it } from 'vitest';
import { validateMCPEgressRolloutChange } from './rollout.js';

describe('MCP egress rollout guard', () => {
  it('keeps emergency downgrade available only with explicit raw-secret acknowledgement', () => {
    expect(
      validateMCPEgressRolloutChange({
        currentMode: 'enforced',
        nextMode: 'off',
        acknowledgeRawSecretDowngrade: false,
        verifiedLegacyExecutorsFenced: false,
      })
    ).toBe('raw_secret_downgrade_acknowledgement_required');
    expect(
      validateMCPEgressRolloutChange({
        currentMode: 'enforced',
        nextMode: 'off',
        acknowledgeRawSecretDowngrade: true,
        verifiedLegacyExecutorsFenced: false,
      })
    ).toBeUndefined();
  });

  it('requires an independently verified legacy-executor fence before enforcement', () => {
    expect(
      validateMCPEgressRolloutChange({
        currentMode: 'compatibility',
        nextMode: 'enforced',
        acknowledgeRawSecretDowngrade: false,
        verifiedLegacyExecutorsFenced: false,
      })
    ).toBe('legacy_executor_fence_attestation_required');
    expect(
      validateMCPEgressRolloutChange({
        currentMode: 'compatibility',
        nextMode: 'enforced',
        acknowledgeRawSecretDowngrade: false,
        verifiedLegacyExecutorsFenced: true,
      })
    ).toBeUndefined();
  });
});
