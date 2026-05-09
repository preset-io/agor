import { describe, expect, it } from 'vitest';
import { formatModelToolMismatchWarning, lintModelToolMatch } from './lint-model-tool-match.js';

describe('lintModelToolMatch', () => {
  describe('happy path (match=ok)', () => {
    it('claude-* matches claude-code', () => {
      expect(lintModelToolMatch('claude-opus-4-7', 'claude-code')?.match).toBe('ok');
      expect(lintModelToolMatch('claude-sonnet-4-6[1m]', 'claude-code')?.match).toBe('ok');
    });
    it('gpt-* matches codex', () => {
      expect(lintModelToolMatch('gpt-5.4', 'codex')?.match).toBe('ok');
      expect(lintModelToolMatch('gpt-5.3-codex', 'codex')?.match).toBe('ok');
    });
    it('o3-* / o4-* matches codex', () => {
      expect(lintModelToolMatch('o3-mini', 'codex')?.match).toBe('ok');
      expect(lintModelToolMatch('o4-mini', 'codex')?.match).toBe('ok');
    });
    it('gemini-* matches gemini', () => {
      expect(lintModelToolMatch('gemini-2.5-flash', 'gemini')?.match).toBe('ok');
    });
    it('matches Google `models/` wrapper after normalization', () => {
      expect(lintModelToolMatch('models/gemini-2.5-flash', 'gemini')?.match).toBe('ok');
    });
    it('case-insensitive', () => {
      expect(lintModelToolMatch('CLAUDE-OPUS-4-7', 'claude-code')?.match).toBe('ok');
    });
  });

  describe('mismatch (the bug we are linting for)', () => {
    it('flags claude model on codex session', () => {
      const r = lintModelToolMatch('claude-opus-4-7', 'codex');
      expect(r?.match).toBe('mismatch');
      if (r?.match === 'mismatch') {
        expect(r.looksLike).toBe('claude-code');
        expect(r.tool).toBe('codex');
        expect(r.model).toBe('claude-opus-4-7');
      }
    });
    it('flags gpt model on claude-code session', () => {
      const r = lintModelToolMatch('gpt-5.4', 'claude-code');
      expect(r?.match).toBe('mismatch');
      if (r?.match === 'mismatch') expect(r.looksLike).toBe('codex');
    });
    it('flags gemini model on codex session', () => {
      const r = lintModelToolMatch('gemini-2.5-flash', 'codex');
      expect(r?.match).toBe('mismatch');
      if (r?.match === 'mismatch') expect(r.looksLike).toBe('gemini');
    });
  });

  describe('unknown (custom strings — no opinion)', () => {
    it('returns unknown for arbitrary internal aliases', () => {
      expect(lintModelToolMatch('internal-model-v1', 'codex')?.match).toBe('unknown');
      expect(lintModelToolMatch('my-byok-proxy', 'claude-code')?.match).toBe('unknown');
    });
    it('does NOT false-positive on substring matches with prefix in the middle', () => {
      // Substring containment would have flagged these; startsWith does not.
      expect(lintModelToolMatch('internal-codename-gpt-5', 'claude-code')?.match).toBe('unknown');
      expect(lintModelToolMatch('my-gemini-proxy-v2', 'codex')?.match).toBe('unknown');
    });
    it('returns null for empty/missing model', () => {
      expect(lintModelToolMatch(undefined, 'codex')).toBeNull();
      expect(lintModelToolMatch(null, 'codex')).toBeNull();
      expect(lintModelToolMatch('', 'codex')).toBeNull();
    });
  });

  describe('unopinionated tools (proxy upstream providers)', () => {
    it('returns null for any model on a copilot session', () => {
      // Copilot routes to Anthropic / OpenAI / Google; any prefix is plausible.
      expect(lintModelToolMatch('claude-sonnet-4.6', 'copilot')).toBeNull();
      expect(lintModelToolMatch('gpt-5.3-codex', 'copilot')).toBeNull();
      expect(lintModelToolMatch('gemini-3-pro', 'copilot')).toBeNull();
    });
    it('returns null for any model on an opencode session', () => {
      expect(lintModelToolMatch('claude-sonnet-4.6', 'opencode')).toBeNull();
      expect(lintModelToolMatch('gpt-5.4', 'opencode')).toBeNull();
    });
    it('produces no warning for unopinionated tools', () => {
      expect(
        formatModelToolMismatchWarning(lintModelToolMatch('claude-sonnet-4.6', 'copilot'))
      ).toBeUndefined();
    });
  });
});

describe('formatModelToolMismatchWarning', () => {
  it('returns a human-readable string for mismatch results', () => {
    const r = lintModelToolMatch('claude-opus-4-7', 'codex');
    const msg = formatModelToolMismatchWarning(r);
    expect(msg).toContain('claude-opus-4-7');
    expect(msg).toContain('claude-code');
    expect(msg).toContain('codex');
  });

  it('returns undefined for ok / unknown / null', () => {
    expect(formatModelToolMismatchWarning(lintModelToolMatch('gpt-5.4', 'codex'))).toBeUndefined();
    expect(
      formatModelToolMismatchWarning(lintModelToolMatch('internal-foo', 'codex'))
    ).toBeUndefined();
    expect(formatModelToolMismatchWarning(null)).toBeUndefined();
  });
});
