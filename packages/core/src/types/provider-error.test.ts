import { describe, expect, it } from 'vitest';
import {
  classifyProviderError,
  PROVIDER_CREDIT_EXHAUSTED_ERROR_CODE,
  PROVIDER_CREDIT_EXHAUSTED_ERROR_KIND,
} from './provider-error';

describe('classifyProviderError', () => {
  it.each([
    'Credit balance is too low',
    'Your credit balance is too low to access this API',
    'You exceeded your current quota, please check your plan and billing details',
    'insufficient_quota',
    'No available credits remain for this request',
  ])('classifies provider credit exhaustion: %s', (message) => {
    expect(classifyProviderError(message)).toEqual({
      kind: PROVIDER_CREDIT_EXHAUSTED_ERROR_KIND,
      code: PROVIDER_CREDIT_EXHAUSTED_ERROR_CODE,
    });
  });

  it('classifies nested provider error objects without returning their body', () => {
    const unsafeBody = 'provider-secret-body-marker';
    const classification = classifyProviderError({
      error: { message: `Credit balance is too low (${unsafeBody})` },
    });

    expect(classification).toEqual({
      kind: PROVIDER_CREDIT_EXHAUSTED_ERROR_KIND,
      code: PROVIDER_CREDIT_EXHAUSTED_ERROR_CODE,
    });
    expect(JSON.stringify(classification)).not.toContain(unsafeBody);
  });

  it('classifies provider responses that expose errors as an array', () => {
    expect(classifyProviderError({ errors: ['Credit balance is too low'] })).toEqual({
      kind: PROVIDER_CREDIT_EXHAUSTED_ERROR_KIND,
      code: PROVIDER_CREDIT_EXHAUSTED_ERROR_CODE,
    });
  });

  it.each([
    'No scoped claude-code credential is configured',
    'Key rejected by provider',
    'The provider is temporarily unavailable',
  ])('keeps non-quota failures unclassified: %s', (message) => {
    expect(classifyProviderError(message)).toBeUndefined();
  });
});
