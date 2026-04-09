import { describe, expect, it } from 'vitest';
import { coerceJsonRecord } from './server.js';

describe('coerceJsonRecord', () => {
  it('passes through a plain object unchanged', () => {
    const obj = { boardId: '123', name: 'test' };
    expect(coerceJsonRecord(obj)).toBe(obj);
  });

  it('passes through undefined unchanged', () => {
    expect(coerceJsonRecord(undefined)).toBeUndefined();
  });

  it('passes through null unchanged', () => {
    expect(coerceJsonRecord(null)).toBeNull();
  });

  it('passes through a number unchanged', () => {
    expect(coerceJsonRecord(42)).toBe(42);
  });

  it('parses a JSON-stringified object back to an object', () => {
    const input = JSON.stringify({ boardId: '123', name: 'test' });
    expect(coerceJsonRecord(input)).toEqual({ boardId: '123', name: 'test' });
  });

  it('parses a complex stringified object with markdown content', () => {
    const obj = {
      worktreeId: 'abc-123',
      initialPrompt:
        '# Hello\n\nSome **markdown** with `backticks` and\n\n```ts\nconst x = 1;\n```',
    };
    expect(coerceJsonRecord(JSON.stringify(obj))).toEqual(obj);
  });

  it('returns "null" string parsed as null (Zod rejects downstream)', () => {
    expect(coerceJsonRecord('null')).toBeNull();
  });

  it('returns "[]" string parsed as array (Zod rejects downstream)', () => {
    expect(coerceJsonRecord('[]')).toEqual([]);
  });

  it('returns "42" string parsed as number (Zod rejects downstream)', () => {
    expect(coerceJsonRecord('42')).toBe(42);
  });

  it('returns empty string unchanged (not valid JSON)', () => {
    expect(coerceJsonRecord('')).toBe('');
  });

  it('returns malformed JSON string unchanged', () => {
    expect(coerceJsonRecord('{bad json')).toBe('{bad json');
  });

  it('returns non-JSON string unchanged', () => {
    expect(coerceJsonRecord('hello world')).toBe('hello world');
  });
});
