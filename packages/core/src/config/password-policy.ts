/**
 * Local-password assignment policy.
 *
 * This module is deliberately browser-safe. The daemon is authoritative, while
 * clients may use the public requirements for early feedback. Password values
 * are never logged or sent to an external breach-checking service.
 */

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
  composition_rules: false;
  periodic_rotation_required: false;
}

export const SECURE_PASSWORD_POLICY_REQUIREMENTS: Readonly<PasswordPolicyRequirements> =
  Object.freeze({
    profile: AgorPasswordPolicyProfile.SECURE,
    min_length: 15,
    max_utf8_bytes: 72,
    common_passwords_rejected: true,
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

// A deliberately local, reviewable deny-list. It catches common long values
// that a length-only rule misses without disclosing a candidate to a third
// party. Comparison removes separators/case so composition suffixes do not
// turn a known password into an accepted one.
const COMMON_PASSWORD_KEYS = new Set([
  '123456789012345',
  '12345678901234567890',
  'abc123abc123abc123',
  'adminadminadmin',
  'administratoradministrator',
  'asdfghjklasdfghjkl',
  'baseballbaseball',
  'changemechangeme',
  'correcthorsebatterystaple',
  'dragondragondragon',
  'footballfootball',
  'iloveyouiloveyou',
  'letmeinletmein',
  'loginloginlogin',
  'mastermastermaster',
  'monkeymonkeymonkey',
  'passwordpassword',
  'passwordpasswordpassword',
  'princessprincess',
  'qwertyuiopasdfgh',
  'qwertyqwertyqwerty',
  'starwarsstarwars',
  'sunshinesunshine',
  'supermansuperman',
  'trustno1trustno1',
  'welcome123welcome123',
  'whateverwhatever',
]);

function comparisonKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function isRepeatedToken(candidate: string, token: string): boolean {
  if (!token || candidate.length < token.length * 2 || candidate.length % token.length !== 0) {
    return false;
  }
  return token.repeat(candidate.length / token.length) === candidate;
}

function isShortRepeatedPattern(candidate: string): boolean {
  const codePoints = Array.from(candidate);
  for (let tokenLength = 1; tokenLength <= 4; tokenLength += 1) {
    const token = codePoints.slice(0, tokenLength).join('');
    if (isRepeatedToken(candidate, token)) return true;
  }
  return false;
}

function isContextSpecificPassword(password: string, context: PasswordPolicyContext): boolean {
  const candidate = comparisonKey(password);
  if (!candidate) return false;

  // Product name/domain and the target account's email are predictable values.
  // Only exact or repeated-token matches are rejected; ordinary passphrases
  // containing a person's name are not subject to arbitrary substring rules.
  const contextValues = ['agor', 'agorlive'];
  if (context.email) {
    const email = context.email.trim();
    const localPart = email.split('@', 1)[0] ?? '';
    contextValues.push(email, localPart);
  }

  return contextValues.some((value) => {
    const key = comparisonKey(value);
    return key.length > 0 && (candidate === key || isRepeatedToken(candidate, key));
  });
}

/** Validate a newly assigned local password under Agor's secure profile. */
export function assertSecurePassword(
  password: unknown,
  context: PasswordPolicyContext = {}
): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new PasswordPolicyError(PasswordValidationCode.REQUIRED, 'Password is required.');
  }

  const length = Array.from(password).length;
  if (length < SECURE_PASSWORD_POLICY_REQUIREMENTS.min_length) {
    throw new PasswordPolicyError(
      PasswordValidationCode.TOO_SHORT,
      `Password must be at least ${SECURE_PASSWORD_POLICY_REQUIREMENTS.min_length} characters.`
    );
  }

  const utf8Bytes = new TextEncoder().encode(password).byteLength;
  if (utf8Bytes > SECURE_PASSWORD_POLICY_REQUIREMENTS.max_utf8_bytes) {
    throw new PasswordPolicyError(
      PasswordValidationCode.TOO_LONG,
      `Password must be at most ${SECURE_PASSWORD_POLICY_REQUIREMENTS.max_utf8_bytes} UTF-8 bytes.`
    );
  }

  const key = comparisonKey(password);
  if (isContextSpecificPassword(password, context)) {
    throw new PasswordPolicyError(
      PasswordValidationCode.CONTEXT_SPECIFIC,
      'Password must not be based only on the account or Agor name.'
    );
  }

  if (
    /^\s+$/u.test(password) ||
    COMMON_PASSWORD_KEYS.has(key) ||
    isShortRepeatedPattern(key) ||
    isShortRepeatedPattern(password.normalize('NFKC').toLocaleLowerCase('en-US'))
  ) {
    throw new PasswordPolicyError(
      PasswordValidationCode.COMMON,
      'Choose a less common password or passphrase.'
    );
  }
}

/** Safe requirements for `/health`; returns no password or deny-list data. */
export function resolvePasswordPolicyRequirements(
  profile: AgorPasswordPolicyProfile | undefined
): PasswordPolicyRequirements {
  // There is intentionally no weak general-purpose profile. Omission and the
  // only accepted named profile both resolve to the fail-safe secure policy.
  if (profile === undefined || profile === AgorPasswordPolicyProfile.SECURE) {
    return { ...SECURE_PASSWORD_POLICY_REQUIREMENTS };
  }
  // Config validation should make this unreachable, but keep the resolver
  // fail-closed for direct callers and malformed deserialized objects.
  throw new Error(`Unsupported password policy profile: ${String(profile)}`);
}
