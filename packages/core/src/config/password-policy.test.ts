import { describe, expect, it } from 'vitest';
import {
  assertSecurePassword,
  PasswordPolicyError,
  PasswordValidationCode,
  resolvePasswordPolicyRequirements,
  SECURE_PASSWORD_POLICY_REQUIREMENTS,
} from './password-policy';

function capture(candidate: unknown, email?: string): PasswordPolicyError {
  try {
    assertSecurePassword(candidate, { email });
  } catch (error) {
    expect(error).toBeInstanceOf(PasswordPolicyError);
    return error as PasswordPolicyError;
  }
  throw new Error('Expected password policy rejection');
}

describe('secure password policy', () => {
  it('uses one fail-safe named profile', () => {
    expect(resolvePasswordPolicyRequirements(undefined)).toEqual(
      SECURE_PASSWORD_POLICY_REQUIREMENTS
    );
    expect(resolvePasswordPolicyRequirements('secure')).toEqual(
      SECURE_PASSWORD_POLICY_REQUIREMENTS
    );
    expect(() => resolvePasswordPolicyRequirements('development' as never)).toThrow(
      /unsupported password policy/i
    );
  });

  it.each([
    [undefined, PasswordValidationCode.REQUIRED],
    ['', PasswordValidationCode.REQUIRED],
    ['short password', PasswordValidationCode.TOO_SHORT],
    ['password-password', PasswordValidationCode.COMMON],
    ['abcdabcdabcdabcd', PasswordValidationCode.COMMON],
    ['                ', PasswordValidationCode.COMMON],
    ['agor-agor-agor-agor', PasswordValidationCode.CONTEXT_SPECIFIC],
    ['alicealicealice', PasswordValidationCode.CONTEXT_SPECIFIC],
  ])('rejects predictable assignment %p with %s', (candidate, code) => {
    expect(capture(candidate, 'alice@example.test').code).toBe(code);
  });

  it('enforces bcrypt input length in UTF-8 bytes rather than JavaScript code units', () => {
    expect(() => assertSecurePassword(`${'limit-'.repeat(11)}123456`)).not.toThrow();
    expect(capture('é'.repeat(37)).code).toBe(PasswordValidationCode.TOO_LONG);
  });

  it('allows long passphrases, spaces, paste-friendly punctuation, and no composition mix', () => {
    expect(() => assertSecurePassword('a sufficiently long lowercase phrase')).not.toThrow();
    expect(() => assertSecurePassword('🦊 🧠 🔐 🧩 🪄 🚀 🌲 🌊')).not.toThrow();
  });

  it('returns machine-readable details without echoing the candidate', () => {
    const candidate = 'unique-secret';
    const error = capture(candidate);
    expect(error.code).toBe(PasswordValidationCode.TOO_SHORT);
    expect(error.requirements).toEqual(SECURE_PASSWORD_POLICY_REQUIREMENTS);
    expect(error.message).not.toContain(candidate);
  });
});
