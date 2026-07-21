/**
 * Shared credential normalization + format-lint. Single source of truth consumed
 * by every credential surface (agent tools, onboarding, gateway, MCP, env vars)
 * and the daemon's at-rest normalization backstop.
 *
 * - Layer 1 (`normalizeCredential`): silent repair, safe on paste/blur/write.
 * - Layer 2 (`lintCredential`): non-blocking format warnings.
 * - Layer 3 (live verify) is provided per-surface via the check-auth service.
 */

export {
  type CredentialLintResult,
  type CredentialLintSeverity,
  lintCredential,
} from './lint.js';
export {
  type CredentialNormalizationChanges,
  type NormalizeCredentialResult,
  normalizeCredential,
} from './normalize.js';
export {
  CREDENTIAL_SPECS,
  type CredentialSpec,
  type CredentialSpecKey,
  isKnownCredentialField,
  resolveCredentialSpec,
} from './specs.js';
