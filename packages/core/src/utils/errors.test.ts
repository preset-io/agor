import { NotFound } from '@feathersjs/errors';
import { describe, expect, it } from 'vitest';
import { isNotFoundError, NotFoundError } from './errors.js';

describe('isNotFoundError', () => {
  it('recognizes Agor repository not-found errors', () => {
    expect(isNotFoundError(new NotFoundError('Branch', 'branch-1'))).toBe(true);
  });

  it('recognizes Feathers service not-found errors', () => {
    expect(isNotFoundError(new NotFound('Branch not found: branch-1'))).toBe(true);
  });

  it('recognizes serialized HTTP 404 errors', () => {
    expect(isNotFoundError({ code: 404, message: 'missing' })).toBe(true);
  });

  it('does not classify unrelated failures as not found', () => {
    expect(isNotFoundError(new Error('No record found in a log message'))).toBe(false);
    expect(isNotFoundError({ code: 'NOT_FOUND' })).toBe(false);
    expect(isNotFoundError({ code: 500 })).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });
});
