/**
 * Shared credential normalization + format-lint. Single source of truth consumed
 * by every credential surface (agent tools, onboarding, gateway, MCP, env vars)
 * and the daemon's at-rest normalization backstop.
 *
 * - Layer 1a (`sanitizeCredential`): always-safe automatic cleanup (edge +
 *   invisible chars), safe on paste/blur/write and as a daemon backstop.
 * - Layer 1b (`detectCredentialFix` / `applyCredentialFix`): opt-in cleanup
 *   (internal whitespace, wrapping quotes) — detected automatically, applied only
 *   on explicit user action. Never rewritten silently.
 * - Layer 2 (`lintCredential`): non-blocking format warnings.
 * - Layer 3 (live verify) is provided per-surface via the check-auth service.
 */

export {
  type CredentialLintResult,
  type CredentialLintSeverity,
  lintCredential,
} from './lint.js';
export {
  applyCredentialFix,
  type CredentialFixKind,
  type CredentialFixSuggestion,
  detectCredentialFix,
  sanitizeCredential,
} from './normalize.js';
export {
  CREDENTIAL_SPECS,
  type CredentialSpec,
  type CredentialSpecKey,
  isKnownCredentialField,
  resolveCredentialSpec,
} from './specs.js';
