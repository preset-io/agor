/**
 * Per-provider credential specs — the single source of truth for how every
 * token/key field across Agor is normalized and format-linted.
 *
 * A "field" is the identifier a surface knows a credential by: the env-var name
 * on the agent-tools screen (`ANTHROPIC_API_KEY`), the gateway config key
 * (`bot_token`), or a user-typed env var name in the env editor. `resolveCredentialSpec`
 * maps any of those to the canonical spec so all surfaces normalize/lint identically.
 */

/** Canonical spec identifier for one class of credential. */
export type CredentialSpecKey =
  | 'anthropic-api-key'
  | 'anthropic-oauth-token'
  | 'anthropic-auth-token'
  | 'openai-api-key'
  | 'gemini-api-key'
  | 'github-token'
  | 'cursor-api-key'
  | 'slack-bot-token'
  | 'slack-app-token'
  | 'pem-private-key'
  | 'base-url';

export interface CredentialSpec {
  key: CredentialSpecKey;
  /** Human provider name used in messages ("Anthropic", "Slack"). */
  provider: string;
  /**
   * `check-auth` tool identifier when this credential is live-verifiable.
   * Absent for credentials with no probe (Slack, PEM, base URL, proxy token).
   */
  authTool?: 'claude-code' | 'codex' | 'gemini' | 'copilot' | 'cursor';
  /** Prefixes a valid value usually starts with. Empty ⇒ no prefix lint. */
  prefixes: string[];
  /** Shortest prefix shown in "usually start with …" hints. */
  prefixHint?: string;
  /**
   * Whether the value is a one-line token. Single-line values get internal
   * whitespace/newlines stripped on normalize (the terminal-paste bug). Multi-line
   * values (PEM keys) get edge-trim only, never internal collapsing.
   */
  singleLine: boolean;
  /** Rough minimum length; shorter ⇒ "looks incomplete" warning. */
  minLength?: number;
  /** Characters allowed in a single-line token body. Violations ⇒ charset error. */
  charset?: RegExp;
}

const TOKEN_CHARSET = /^[A-Za-z0-9._-]+$/;

export const CREDENTIAL_SPECS: Record<CredentialSpecKey, CredentialSpec> = {
  'anthropic-api-key': {
    key: 'anthropic-api-key',
    provider: 'Anthropic',
    authTool: 'claude-code',
    prefixes: ['sk-ant-api'],
    prefixHint: 'sk-ant-api',
    singleLine: true,
    minLength: 40,
    charset: TOKEN_CHARSET,
  },
  'anthropic-oauth-token': {
    key: 'anthropic-oauth-token',
    provider: 'Anthropic',
    prefixes: ['sk-ant-oat'],
    prefixHint: 'sk-ant-oat',
    singleLine: true,
    minLength: 40,
    charset: TOKEN_CHARSET,
  },
  'anthropic-auth-token': {
    // Proxy / enterprise bearer token — format is gateway-defined, so no prefix
    // or charset lint. Still single-line, so it benefits from whitespace repair.
    key: 'anthropic-auth-token',
    provider: 'Anthropic',
    prefixes: [],
    singleLine: true,
  },
  'openai-api-key': {
    key: 'openai-api-key',
    provider: 'OpenAI',
    authTool: 'codex',
    prefixes: ['sk-proj-', 'sk-'],
    prefixHint: 'sk-',
    singleLine: true,
    minLength: 30,
    charset: TOKEN_CHARSET,
  },
  'gemini-api-key': {
    key: 'gemini-api-key',
    provider: 'Google',
    authTool: 'gemini',
    prefixes: ['AIza'],
    prefixHint: 'AIza',
    singleLine: true,
    minLength: 20,
    charset: TOKEN_CHARSET,
  },
  'github-token': {
    key: 'github-token',
    provider: 'GitHub',
    authTool: 'copilot',
    prefixes: ['ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_', 'ghr_'],
    prefixHint: 'ghp_ or github_pat_',
    singleLine: true,
    minLength: 20,
    charset: TOKEN_CHARSET,
  },
  'cursor-api-key': {
    key: 'cursor-api-key',
    provider: 'Cursor',
    authTool: 'cursor',
    prefixes: ['key_'],
    prefixHint: 'key_',
    singleLine: true,
    minLength: 20,
    charset: TOKEN_CHARSET,
  },
  'slack-bot-token': {
    key: 'slack-bot-token',
    provider: 'Slack',
    prefixes: ['xoxb-'],
    prefixHint: 'xoxb-',
    singleLine: true,
    minLength: 20,
    charset: TOKEN_CHARSET,
  },
  'slack-app-token': {
    key: 'slack-app-token',
    provider: 'Slack',
    prefixes: ['xapp-'],
    prefixHint: 'xapp-',
    singleLine: true,
    minLength: 20,
    charset: TOKEN_CHARSET,
  },
  'pem-private-key': {
    // Multi-line PEM. Edge-trim only — internal newlines are structural.
    key: 'pem-private-key',
    provider: 'GitHub',
    prefixes: ['-----BEGIN'],
    prefixHint: '-----BEGIN',
    singleLine: false,
  },
  'base-url': {
    // Non-secret endpoint URL. Single-line (URLs never contain whitespace) but
    // no prefix/charset lint — any valid URL shape is acceptable.
    key: 'base-url',
    provider: '',
    prefixes: [],
    singleLine: true,
  },
};

/**
 * Field-name → spec mapping. Covers agent-tool env var names, gateway config
 * keys, and the common env var names users type into the env editor. Unknown
 * names resolve to `undefined` (generic conservative normalization, no lint).
 */
const FIELD_TO_SPEC: Record<string, CredentialSpecKey> = {
  // Agentic tool env var fields (ApiKeyFields / OnboardingWizard)
  ANTHROPIC_API_KEY: 'anthropic-api-key',
  CLAUDE_CODE_OAUTH_TOKEN: 'anthropic-oauth-token',
  ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-token',
  ANTHROPIC_BASE_URL: 'base-url',
  OPENAI_API_KEY: 'openai-api-key',
  OPENAI_BASE_URL: 'base-url',
  GEMINI_API_KEY: 'gemini-api-key',
  COPILOT_GITHUB_TOKEN: 'github-token',
  CURSOR_API_KEY: 'cursor-api-key',
  // Common git tokens users store as raw env vars
  GH_TOKEN: 'github-token',
  GITHUB_TOKEN: 'github-token',
  // Gateway channel config keys (GatewayTokenWidget / GatewayChannelsTable)
  bot_token: 'slack-bot-token',
  app_token: 'slack-app-token',
  private_key: 'pem-private-key',
};

/** Every spec key is also accepted verbatim as a field identifier. */
export function resolveCredentialSpec(field: string): CredentialSpec | undefined {
  if (field in CREDENTIAL_SPECS) return CREDENTIAL_SPECS[field as CredentialSpecKey];
  const key = FIELD_TO_SPEC[field];
  return key ? CREDENTIAL_SPECS[key] : undefined;
}

/** True when a field maps to a known credential spec (used by the env editor). */
export function isKnownCredentialField(field: string): boolean {
  return resolveCredentialSpec(field) !== undefined;
}
