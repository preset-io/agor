/**
 * At-rest backstop for agentic_tools credentials (the path from the original bug
 * report). The daemon must strip only edge whitespace + invisible characters and
 * NEVER auto-fix internal whitespace or wrapping quotes — a value the user chose
 * to keep (declined the opt-in "Clean it up") is stored byte-for-byte.
 */

import { decryptApiKey } from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import { applyAgenticToolsPatch } from './users';

function storedValue(input: string): string {
  const next = applyAgenticToolsPatch({}, { 'claude-code': { ANTHROPIC_API_KEY: input } });
  const bucket = next['claude-code'] as Record<string, string>;
  return decryptApiKey(bucket.ANTHROPIC_API_KEY);
}

describe('applyAgenticToolsPatch — at-rest backstop', () => {
  it('strips edge whitespace and invisible characters', () => {
    const bom = '﻿';
    expect(storedValue(`  ${bom}sk-ant-api03-clean0123456789  `)).toBe(
      'sk-ant-api03-clean0123456789'
    );
  });

  it('does NOT collapse internal whitespace at rest (declined fix stored as-is)', () => {
    expect(storedValue('sk-ant-api03-abc def0123456789')).toBe('sk-ant-api03-abc def0123456789');
  });

  it('does NOT unwrap wrapping quotes at rest', () => {
    expect(storedValue('"sk-ant-api03-token0123456789"')).toBe('"sk-ant-api03-token0123456789"');
  });
});
