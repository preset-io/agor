import { describe, expect, it } from 'vitest';
import { lintCredential } from './lint.js';
import { applyCredentialFix, detectCredentialFix, sanitizeCredential } from './normalize.js';
import { isKnownCredentialField, resolveCredentialSpec } from './specs.js';

describe('sanitizeCredential (always-safe automatic cleanup)', () => {
  it('strips edge whitespace and newlines', () => {
    expect(sanitizeCredential('  sk-ant-api03-abcDEF123456  \n')).toBe('sk-ant-api03-abcDEF123456');
  });

  it('strips zero-width / invisible characters', () => {
    const zwsp = '​';
    const bom = '﻿';
    expect(sanitizeCredential(`AIza${zwsp}abcdef${bom}123456`)).toBe('AIzaabcdef123456');
  });

  it('NEVER collapses internal whitespace (the user keeps what they typed)', () => {
    expect(sanitizeCredential('sk-ant-api03-abc DEF123456')).toBe('sk-ant-api03-abc DEF123456');
  });

  it('NEVER unwraps quotes', () => {
    expect(sanitizeCredential('"sk-ant-api03-token"')).toBe('"sk-ant-api03-token"');
    expect(sanitizeCredential('“https://api.example.com”')).toBe('“https://api.example.com”');
  });

  it('leaves a clean token untouched', () => {
    expect(sanitizeCredential('sk-ant-api03-cleanTOKEN0123456789')).toBe(
      'sk-ant-api03-cleanTOKEN0123456789'
    );
  });
});

describe('detectCredentialFix (opt-in — never applied automatically)', () => {
  it('detects a mid-token space on a known field', () => {
    const fix = detectCredentialFix('ANTHROPIC_API_KEY', 'sk-ant-api03-abc DEF123456');
    expect(fix?.kinds).toContain('internal-whitespace');
    expect(fix?.fixedValue).toBe('sk-ant-api03-abcDEF123456');
    expect(fix?.message).toMatch(/spaces or line breaks/i);
  });

  it('detects a mid-token newline', () => {
    const fix = detectCredentialFix('OPENAI_API_KEY', 'sk-proj-abc\ndef123456789012345');
    expect(fix?.kinds).toContain('internal-whitespace');
    expect(fix?.fixedValue).toBe('sk-proj-abcdef123456789012345');
  });

  it('detects wrapping quotes (ASCII, smart, backtick)', () => {
    expect(detectCredentialFix('ANTHROPIC_API_KEY', '"sk-ant-api03-token0000"')?.kinds).toEqual([
      'wrapping-quotes',
    ]);
    expect(detectCredentialFix('ANTHROPIC_BASE_URL', '“https://api.example.com”')?.fixedValue).toBe(
      'https://api.example.com'
    );
    expect(detectCredentialFix('OPENAI_API_KEY', '`sk-proj-token00000`')?.fixedValue).toBe(
      'sk-proj-token00000'
    );
  });

  it('reports both kinds when the value is quoted AND has internal whitespace', () => {
    const fix = detectCredentialFix('ANTHROPIC_API_KEY', '"sk-ant-api03-abc DEF"');
    expect(fix?.kinds).toEqual(['wrapping-quotes', 'internal-whitespace']);
    expect(fix?.fixedValue).toBe('sk-ant-api03-abcDEF');
    expect(fix?.message).toMatch(/wrapping quotes/i);
  });

  it('returns null for a clean known token', () => {
    expect(detectCredentialFix('ANTHROPIC_API_KEY', 'sk-ant-api03-clean0123456789')).toBeNull();
  });

  it('returns null for unknown fields (arbitrary values are never touched)', () => {
    expect(detectCredentialFix('SOME_RANDOM_VAR', 'a b c')).toBeNull();
    expect(detectCredentialFix('SOME_RANDOM_VAR', '“hello world”')).toBeNull();
  });

  it('returns null for multi-line PEM fields', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nLINE1\nLINE2\n-----END PRIVATE KEY-----';
    expect(detectCredentialFix('private_key', pem)).toBeNull();
  });

  it('ignores invisible/edge noise (only genuine internal issues trigger it)', () => {
    const bom = '﻿';
    expect(detectCredentialFix('GEMINI_API_KEY', `  AIzaClean0123456789${bom}  `)).toBeNull();
  });
});

describe('applyCredentialFix (only invoked on explicit user action)', () => {
  it('collapses internal whitespace and unwraps quotes for known single-line fields', () => {
    expect(applyCredentialFix('ANTHROPIC_API_KEY', '"sk-ant-api03-abc DEF"')).toBe(
      'sk-ant-api03-abcDEF'
    );
  });

  it('is edge/invisible-only (no-op beyond sanitize) for unknown or PEM fields', () => {
    expect(applyCredentialFix('SOME_RANDOM_VAR', '“a b c”')).toBe('“a b c”');
    const pem = '-----BEGIN KEY-----\nA B\n-----END KEY-----';
    expect(applyCredentialFix('private_key', `  ${pem}  `)).toBe(pem);
  });
});

describe('lintCredential', () => {
  it('returns null for a well-formed Anthropic API key', () => {
    expect(
      lintCredential('ANTHROPIC_API_KEY', 'sk-ant-api03-abcDEF0123456789abcDEF0123456789xyz')
    ).toBeNull();
  });

  it('warns about a truncated (too short) key', () => {
    const r = lintCredential('ANTHROPIC_API_KEY', 'sk-ant-api03-short');
    expect(r?.severity).toBe('warning');
    expect(r?.code).toBe('length');
  });

  it('warns about a wrong prefix', () => {
    const r = lintCredential('GEMINI_API_KEY', 'ya29-abcdefghijklmnop');
    expect(r?.severity).toBe('warning');
    expect(r?.code).toBe('prefix');
  });

  it('detects Anthropic OAuth token pasted into the API-key field', () => {
    const r = lintCredential('ANTHROPIC_API_KEY', 'sk-ant-oat01-abcDEF0123456789abcDEF0123456789');
    expect(r?.code).toBe('cross-paste');
    expect(r?.suggestField).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('detects Anthropic API key pasted into the subscription field', () => {
    const r = lintCredential(
      'CLAUDE_CODE_OAUTH_TOKEN',
      'sk-ant-api03-abcDEF0123456789abcDEF0123456789'
    );
    expect(r?.code).toBe('cross-paste');
    expect(r?.suggestField).toBe('ANTHROPIC_API_KEY');
  });

  it('errors on an impossible charset (stray space that survived)', () => {
    const r = lintCredential('OPENAI_API_KEY', 'sk-proj-abc def with spaces here 12345');
    expect(r?.severity).toBe('error');
    expect(r?.code).toBe('charset');
  });

  it('never lints an unknown field', () => {
    expect(lintCredential('SOME_RANDOM_VAR', 'anything at all')).toBeNull();
  });

  it('does not lint a base URL by prefix/charset', () => {
    expect(lintCredential('ANTHROPIC_BASE_URL', 'https://api.example.com/v1')).toBeNull();
  });

  it('recognizes both OpenAI prefixes', () => {
    expect(lintCredential('OPENAI_API_KEY', 'sk-proj-abcdefghijklmnopqrstuvwx')).toBeNull();
    expect(lintCredential('OPENAI_API_KEY', 'sk-abcdefghijklmnopqrstuvwxyz012')).toBeNull();
  });
});

describe('resolveCredentialSpec', () => {
  it('maps env var names, gateway keys, and spec keys', () => {
    expect(resolveCredentialSpec('ANTHROPIC_API_KEY')?.key).toBe('anthropic-api-key');
    expect(resolveCredentialSpec('bot_token')?.key).toBe('slack-bot-token');
    expect(resolveCredentialSpec('GH_TOKEN')?.key).toBe('github-token');
    expect(resolveCredentialSpec('slack-app-token')?.key).toBe('slack-app-token');
    expect(resolveCredentialSpec('UNKNOWN')).toBeUndefined();
  });

  it('maps generic single-line secrets (gateway secrets + embedding api_key)', () => {
    for (const field of [
      'app_password',
      'api_token',
      'signing_secret',
      'webhook_secret',
      'api_key',
    ]) {
      expect(resolveCredentialSpec(field)?.key).toBe('generic-secret');
    }
  });

  it('reports known-credential fields for the env editor', () => {
    expect(isKnownCredentialField('COPILOT_GITHUB_TOKEN')).toBe(true);
    expect(isKnownCredentialField('MY_APP_FLAG')).toBe(false);
  });
});

describe('generic-secret specs (gateway secrets + embedding api_key)', () => {
  it('offers an opt-in internal-space fix without any lint', () => {
    const fix = detectCredentialFix('signing_secret', 'abc def12345678');
    expect(fix?.fixedValue).toBe('abcdef12345678');
    expect(fix?.kinds).toContain('internal-whitespace');
    expect(lintCredential('signing_secret', 'abc def12345678')).toBeNull();
  });

  it('does not prefix- or charset-lint a generic embedding api_key', () => {
    expect(lintCredential('api_key', 'anything-goes_here.123')).toBeNull();
  });
});
