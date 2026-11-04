/**
 * Last-line secret scan for `.agorpack` content. Exporters never copy secret
 * columns in the first place; this pass catches values that leaked into free
 * text (memory files, prompts, working-tree files) before they leave the
 * install. Patterns are token *shapes*, so a hit is a strong signal.
 */

export interface SecretPattern {
  id: string;
  pattern: RegExp;
}

export const AGOR_PACK_SECRET_PATTERNS: readonly SecretPattern[] = [
  // Agor's AES-GCM envelope (`salt:iv:tag:data`, hex) from db/encryption.ts.
  {
    id: 'agor_encrypted_value',
    pattern: /\b[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{2,}\b/,
  },
  { id: 'agor_api_key', pattern: /\bagor_sk_[A-Za-z0-9_-]{16,}/ },
  { id: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'slack_app_token', pattern: /\bxapp-[0-9]+-[A-Za-z0-9-]{10,}/ },
  { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { id: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'aws_access_key', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'private_key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
];

export interface SecretScanHit {
  id: string;
}

/** Pattern ids found in `text` (never the matched value). */
export function scanForSecrets(text: string): SecretScanHit[] {
  const hits: SecretScanHit[] = [];
  for (const { id, pattern } of AGOR_PACK_SECRET_PATTERNS) {
    if (pattern.test(text)) hits.push({ id });
  }
  return hits;
}

/** Replace every secret-shaped value with a marker; returns the count. */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let out = text;
  for (const { id, pattern } of AGOR_PACK_SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    out = out.replace(global, () => {
      redacted += 1;
      return `[redacted:${id}]`;
    });
  }
  return { text: out, redacted };
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
