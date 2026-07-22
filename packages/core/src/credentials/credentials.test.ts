import { describe, expect, it } from 'vitest';
import { lintCredential } from './lint.js';
import { normalizeCredential } from './normalize.js';
import { isKnownCredentialField, resolveCredentialSpec } from './specs.js';

describe('normalizeCredential', () => {
  it('strips edge whitespace and newlines', () => {
    const r = normalizeCredential('ANTHROPIC_API_KEY', '  sk-ant-api03-abcDEF123456  \n');
    expect(r.value).toBe('sk-ant-api03-abcDEF123456');
    expect(r.changed).toBe(true);
    expect(r.internalWhitespaceFixed).toBe(false);
  });

  it('removes a mid-token space and flags the internal fix (the terminal-paste bug)', () => {
    const r = normalizeCredential('ANTHROPIC_API_KEY', 'sk-ant-api03-abc DEF123456');
    expect(r.value).toBe('sk-ant-api03-abcDEF123456');
    expect(r.internalWhitespaceFixed).toBe(true);
    expect(r.changes.collapsedInternal).toBe(true);
  });

  it('removes a mid-token newline and flags the internal fix', () => {
    const r = normalizeCredential('OPENAI_API_KEY', 'sk-proj-abc\ndef123456789012345');
    expect(r.value).toBe('sk-proj-abcdef123456789012345');
    expect(r.internalWhitespaceFixed).toBe(true);
  });

  it('strips zero-width characters without flagging an internal fix', () => {
    const zwsp = '​';
    const bom = '﻿';
    const r = normalizeCredential('GEMINI_API_KEY', `AIza${zwsp}abcdef${bom}123456`);
    expect(r.value).toBe('AIzaabcdef123456');
    expect(r.changes.strippedZeroWidth).toBe(true);
    expect(r.internalWhitespaceFixed).toBe(false);
  });

  it('strips smart quotes wrapping the whole value and flags an internal fix', () => {
    const r = normalizeCredential('ANTHROPIC_BASE_URL', '“https://api.example.com”');
    expect(r.value).toBe('https://api.example.com');
    expect(r.changes.strippedWrappingQuotes).toBe(true);
    expect(r.internalWhitespaceFixed).toBe(true);
  });

  it('strips ASCII double quotes wrapping a token (no quote char left behind)', () => {
    const r = normalizeCredential('ANTHROPIC_API_KEY', '"sk-ant-api03-abcDEF0123456789abcDEF"');
    expect(r.value).toBe('sk-ant-api03-abcDEF0123456789abcDEF');
    expect(r.changes.strippedWrappingQuotes).toBe(true);
    expect(r.internalWhitespaceFixed).toBe(true);
  });

  it('strips wrapping backticks', () => {
    const r = normalizeCredential('OPENAI_API_KEY', '`sk-proj-abcdefghijklmnopqrstuv`');
    expect(r.value).toBe('sk-proj-abcdefghijklmnopqrstuv');
    expect(r.changes.strippedWrappingQuotes).toBe(true);
  });

  it('leaves a quote in the MIDDLE of the value untouched (charset lint owns it)', () => {
    const r = normalizeCredential('OPENAI_API_KEY', 'sk-proj-abc"def0123456789012');
    expect(r.value).toBe('sk-proj-abc"def0123456789012');
    expect(r.changes.strippedWrappingQuotes).toBe(false);
    expect(lintCredential('OPENAI_API_KEY', r.value)?.code).toBe('charset');
  });

  it('does NOT strip wrapping quotes for unknown fields (arbitrary values preserved)', () => {
    const r = normalizeCredential('SOME_RANDOM_VAR', '“hello world”');
    expect(r.value).toBe('“hello world”');
    expect(r.changed).toBe(false);
    expect(r.internalWhitespaceFixed).toBe(false);
  });

  it('leaves a clean token untouched', () => {
    const r = normalizeCredential('ANTHROPIC_API_KEY', 'sk-ant-api03-cleanTOKEN0123456789');
    expect(r.changed).toBe(false);
    expect(r.value).toBe('sk-ant-api03-cleanTOKEN0123456789');
  });

  it('edge-trims a PEM private key but never touches internal newlines', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nLINE1\nLINE2\n-----END PRIVATE KEY-----';
    const r = normalizeCredential('private_key', `\n  ${pem}  \n`);
    expect(r.value).toBe(pem);
    expect(r.internalWhitespaceFixed).toBe(false);
    expect(r.changes.collapsedInternal).toBe(false);
  });

  it('does not collapse internal whitespace for unknown fields', () => {
    const r = normalizeCredential('SOME_RANDOM_VAR', 'a b c');
    expect(r.value).toBe('a b c');
    expect(r.internalWhitespaceFixed).toBe(false);
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
  it('collapses an internal space and flags the fix, without any lint', () => {
    const r = normalizeCredential('signing_secret', 'abc def12345678');
    expect(r.value).toBe('abcdef12345678');
    expect(r.internalWhitespaceFixed).toBe(true);
    expect(lintCredential('signing_secret', r.value)).toBeNull();
  });

  it('does not prefix- or charset-lint a generic embedding api_key', () => {
    expect(lintCredential('api_key', 'anything-goes_here.123')).toBeNull();
  });
});
