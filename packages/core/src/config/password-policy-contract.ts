/** Browser-safe public contract for local-password assignment. */

export const AgorPasswordPolicyProfile = {
  SECURE: 'secure',
} as const;
export type AgorPasswordPolicyProfile =
  (typeof AgorPasswordPolicyProfile)[keyof typeof AgorPasswordPolicyProfile];

export const PasswordValidationCode = {
  REQUIRED: 'PASSWORD_REQUIRED',
  TOO_SHORT: 'PASSWORD_TOO_SHORT',
  TOO_LONG: 'PASSWORD_TOO_LONG',
  COMMON: 'PASSWORD_COMMON',
  CONTEXT_SPECIFIC: 'PASSWORD_CONTEXT_SPECIFIC',
  HASH_NOT_ACCEPTED: 'PASSWORD_HASH_NOT_ACCEPTED',
  CREDENTIAL_METADATA_NOT_ACCEPTED: 'PASSWORD_CREDENTIAL_METADATA_NOT_ACCEPTED',
} as const;
export type PasswordValidationCode =
  (typeof PasswordValidationCode)[keyof typeof PasswordValidationCode];

export interface PasswordPolicyRequirements {
  profile: AgorPasswordPolicyProfile;
  /** Minimum Unicode code points for an assigned password. */
  min_length: number;
  /** bcrypt's safe input boundary, measured after UTF-8 encoding. */
  max_utf8_bytes: number;
  common_passwords_rejected: true;
  /** Version identifier for the offline common-password corpus. */
  blocklist_version?: string;
  composition_rules: false;
  periodic_rotation_required: false;
}

export const PASSWORD_BLOCKLIST_VERSION = 'seclists-10k-e9d6a61e';

export const SECURE_PASSWORD_POLICY_REQUIREMENTS: Readonly<PasswordPolicyRequirements> =
  Object.freeze({
    profile: AgorPasswordPolicyProfile.SECURE,
    min_length: 15,
    max_utf8_bytes: 72,
    common_passwords_rejected: true,
    blocklist_version: PASSWORD_BLOCKLIST_VERSION,
    composition_rules: false,
    periodic_rotation_required: false,
  });

export interface PasswordPolicyContext {
  email?: string;
}

export class PasswordPolicyError extends Error {
  readonly code: PasswordValidationCode;
  readonly requirements = SECURE_PASSWORD_POLICY_REQUIREMENTS;

  constructor(code: PasswordValidationCode, message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
    this.code = code;
  }
}

/** Safe requirements for `/health`; returns no password or deny-list data. */
export function resolvePasswordPolicyRequirements(
  profile: AgorPasswordPolicyProfile | undefined
): PasswordPolicyRequirements {
  if (profile === undefined || profile === AgorPasswordPolicyProfile.SECURE) {
    return { ...SECURE_PASSWORD_POLICY_REQUIREMENTS };
  }
  throw new Error(`Unsupported password policy profile: ${String(profile)}`);
}
