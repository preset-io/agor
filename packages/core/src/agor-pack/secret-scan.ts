/**
 * Last-line secret scan for `.agor` content. Exporters never copy secret
 * columns in the first place; this pass catches values that leaked into free
 * text (memory files, prompts, working-tree files) before they leave the
 * install. Patterns are token *shapes*, so a hit is a strong signal.
 */

import { ENCRYPTED_ENVELOPE_PATTERN } from '../db/encryption';

export interface SecretPattern {
  id: string;
  pattern: RegExp;
}

/** Exactly one `{{ user.env.NAME }}` reference. */
const ENV_REFERENCE = String.raw`\{\{\s*user\.env\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}`;
/** One piece of a URL username / password: a whole template, or a plain character. */
const USER_TOKEN = String.raw`\{\{[^{}]*\}\}|[^\s/:@{}]`;
const URL_TOKEN = String.raw`\{\{[^{}]*\}\}|[^\s/@{}]`;
/** One piece of a query value: a whole template, or a plain character. */
const QUERY_TOKEN = String.raw`\{\{[^{}]*\}\}|[^&#\s"'{}]`;

export const AGOR_PACK_SECRET_PATTERNS: readonly SecretPattern[] = [
  // Agor's AES-GCM envelope (`salt:iv:tag:data`, hex).
  { id: 'agor_encrypted_value', pattern: ENCRYPTED_ENVELOPE_PATTERN },
  { id: 'agor_api_key', pattern: /\bagor_sk_[A-Za-z0-9_-]{16,}/ },
  { id: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'slack_app_token', pattern: /\bxapp-[0-9]+-[A-Za-z0-9-]{10,}/ },
  { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { id: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'aws_access_key', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  // A password in a URL (`https://user:password@host`), unless the password
  // is exactly one `{{ user.env.NAME }}` reference (templates count as one
  // token here, so a literal mixed with a reference still matches).
  {
    id: 'url_userinfo',
    pattern: new RegExp(
      String.raw`\b[a-z][a-z0-9+.-]*:\/\/(?:${USER_TOKEN})+:(?!${ENV_REFERENCE}@)(?:${URL_TOKEN})+@`,
      'i'
    ),
  },
  // A credential-named query parameter whose value is not exactly one
  // reference: a literal of 8+ characters, or anything mixing in a template.
  {
    id: 'url_credential_param',
    pattern: new RegExp(
      String.raw`[?&](?:api[_-]?key|apikey|access[_-]?key|access[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd|signature|sig)=(?!(?:${ENV_REFERENCE}|\[redacted(?::[a-z_]+)?\])(?:[&#\s"']|$))(?:(?:${QUERY_TOKEN})*\{\{[^{}]*\}\}(?:${QUERY_TOKEN})*|[^&#\s"'{}]{8,})`,
      'i'
    ),
  },
  // The whole block (header, key material, footer), or to the end of the text
  // when the footer is missing, so redaction never leaves usable key material.
  {
    id: 'private_key',
    pattern:
      /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----(?:[\s\S]*?-----END \1PRIVATE KEY-----|[\s\S]*$)/,
  },
];

export interface SecretScanHit {
  id: string;
}

/** Pattern ids found in `text` (never the matched value). */
/** A query parameter name, percent-decoded and lowercased (`%74oKen` → `token`). */
export function decodeQueryName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, ' ')).toLowerCase();
  } catch {
    return name.toLowerCase();
  }
}

/** Decode percent-encoded query parameter names so name-based patterns see them. */
function withDecodedQueryNames(text: string): string {
  if (!text.includes('%')) return text;
  return text.replace(
    /([?&])([^=&#\s"']*%[0-9A-Fa-f]{2}[^=&#\s"']*)=/g,
    (_whole, separator: string, name: string) => `${separator}${decodeQueryName(name)}=`
  );
}

export function scanForSecrets(raw: string): SecretScanHit[] {
  const text = withDecodedQueryNames(raw);
  const hits: SecretScanHit[] = [];
  for (const { id, pattern } of AGOR_PACK_SECRET_PATTERNS) {
    if (pattern.test(text)) hits.push({ id });
  }
  return hits;
}

/** Replace every secret-shaped value with a marker; returns the count. */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let out = withDecodedQueryNames(text);
  for (const { id, pattern } of AGOR_PACK_SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    out = out.replace(global, () => {
      redacted += 1;
      return `[redacted:${id}]`;
    });
  }
  return { text: out, redacted };
}

/**
 * Redact every string inside a JSON-shaped value. Scanning serialized JSON is
 * not enough: escapes such as `\n` put a word character right before a token,
 * which defeats the patterns' word boundaries.
 */
export function redactSecretsDeep<T>(value: T): { value: T; redacted: number } {
  let redacted = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const result = redactSecrets(node);
      redacted += result.redacted;
      return result.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return { value: walk(value) as T, redacted };
}

/** Pattern ids found in any string (keys included) inside a JSON-shaped value. */
export function scanForSecretsDeep(value: unknown): SecretScanHit[] {
  const ids = new Set<string>();
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      for (const hit of scanForSecrets(node)) ids.add(hit.id);
    } else if (Array.isArray(node)) {
      for (const child of node) walk(child);
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        walk(key);
        walk(child);
      }
    }
  };
  walk(value);
  return [...ids].map((id) => ({ id }));
}

export class AgorPackSecretError extends Error {
  constructor(
    readonly entryPath: string,
    readonly patternIds: string[]
  ) {
    super(
      `Refusing to export: ${entryPath} contains a value that looks like a secret (${patternIds.join(', ')}). Remove it or leave that section out.`
    );
    this.name = 'AgorPackSecretError';
  }
}

/** Throw when `text` (the content of `entryPath`) contains a secret shape. */
export function assertNoSecrets(entryPath: string, text: string): void {
  const hits = scanForSecrets(text);
  if (hits.length > 0) {
    throw new AgorPackSecretError(
      entryPath,
      hits.map((hit) => hit.id)
    );
  }
}

/** {@link assertNoSecrets} over the decoded strings of a JSON-shaped value. */
export function assertNoSecretsDeep(entryPath: string, value: unknown): void {
  const hits = scanForSecretsDeep(value);
  if (hits.length > 0) {
    throw new AgorPackSecretError(
      entryPath,
      hits.map((hit) => hit.id)
    );
  }
}
