/**
 * Local-password assignment policy.
 *
 * The daemon is authoritative. Public browser-safe types and requirement
 * metadata live in `password-policy-contract`; the versioned blocklist stays
 * out of browser bundles. Password values are never logged or sent externally.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type PasswordPolicyContext,
  PasswordPolicyError,
  PasswordValidationCode,
  SECURE_PASSWORD_POLICY_REQUIREMENTS,
} from './password-policy-contract';

export * from './password-policy-contract';

const PASSWORD_BLOCKLIST_FILENAME = 'password-blocklist-v1.txt';

function loadCommonPasswordBlocklist(): string[] {
  // Source-mode imports resolve beside this module. Bundled @agor/core entry
  // points can live at dist/, dist/config/, dist/db/, or dist/seed/, so walk a
  // bounded set of parents looking for the one copied config asset.
  let directory = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  for (let depth = 0; depth < 3; depth += 1) {
    candidates.push(
      join(directory, PASSWORD_BLOCKLIST_FILENAME),
      join(directory, 'config', PASSWORD_BLOCKLIST_FILENAME)
    );
    directory = dirname(directory);
  }

  for (const candidate of new Set(candidates)) {
    try {
      const entries = readFileSync(candidate, 'utf8')
        .split(/\r?\n/u)
        .filter((entry) => entry.length > 0);
      if (entries.length !== 10_000) {
        throw new Error(`expected 10000 entries, found ${entries.length}`);
      }
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`Invalid offline password blocklist at ${candidate}`, { cause: error });
    }
  }
  throw new Error('Offline password blocklist asset is missing from @agor/core');
}

function comparisonKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Comparison removes separators/case so cosmetic composition does not turn a
// known password into an accepted one. The source corpus is version-pinned and
// entirely local; candidate passwords never leave the daemon/CLI process.
const COMMON_PASSWORD_KEYS = new Set(
  loadCommonPasswordBlocklist()
    .map(comparisonKey)
    .filter((key) => key.length > 0)
);
// Expected/common values that are important to Agor's policy contract but do
// not appear verbatim in the pinned top-10k corpus.
for (const key of ['correcthorsebatterystaple', 'adminadminadmin', 'passwordpassword']) {
  COMMON_PASSWORD_KEYS.add(key);
}

function isRepeatedToken(candidate: string, token: string): boolean {
  if (!token || candidate.length < token.length * 2 || candidate.length % token.length !== 0) {
    return false;
  }
  return token.repeat(candidate.length / token.length) === candidate;
}

function isRepeatedPattern(candidate: string): boolean {
  const codePoints = Array.from(candidate);
  for (let tokenLength = 1; tokenLength <= Math.floor(codePoints.length / 2); tokenLength += 1) {
    if (codePoints.length % tokenLength !== 0) continue;
    const token = codePoints.slice(0, tokenLength).join('');
    if (isRepeatedToken(candidate, token)) return true;
  }
  return false;
}

function isCommonPasswordVariant(candidate: string): boolean {
  if (COMMON_PASSWORD_KEYS.has(candidate)) return true;

  // A common alphabetic password plus a numeric suffix/prefix is still an
  // expected guessing candidate even when the exact variant falls outside the
  // top-10k corpus (for example password1234567 or qwerty123456789).
  const suffix = candidate.match(/^(\p{L}+)(\d{2,})$/u);
  if (suffix && COMMON_PASSWORD_KEYS.has(suffix[1])) return true;
  const prefix = candidate.match(/^(\d{2,})(\p{L}+)$/u);
  return !!prefix && COMMON_PASSWORD_KEYS.has(prefix[2]);
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
    isCommonPasswordVariant(key) ||
    isRepeatedPattern(key) ||
    isRepeatedPattern(password.normalize('NFKC').toLocaleLowerCase('en-US'))
  ) {
    throw new PasswordPolicyError(
      PasswordValidationCode.COMMON,
      'Choose a less common password or passphrase.'
    );
  }
}
