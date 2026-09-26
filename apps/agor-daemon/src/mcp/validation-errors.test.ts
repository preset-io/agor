import { BadRequest, Forbidden } from '@agor/core/feathers';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { inputValidationIssues, mcpValidationFailure } from './validation-errors.js';

describe('MCP validation diagnostics', () => {
  it('distinguishes downstream validation without attributing it to the caller or exposing raw AJV data', () => {
    const error = new BadRequest(
      'validation failed',
      Array.from({ length: 20 }, () => ({
        instancePath: '/branch_id/secret-value',
        keyword: 'type',
        message: 'secret-value',
        params: { type: 'secret-value' },
        data: 'secret-value',
      }))
    );
    const result = mcpValidationFailure(error, 'agor_boards_get')!;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: 'validation failed',
      code: 'service_validation_failed',
      validation_stage: 'service',
      retryable: false,
      issues: Array(8).fill({ field: 'branch_id', code: 'type' }),
    });
    expect(result.content[0].text).not.toContain('secret-value');
  });
  it('does not expose dynamic field names, arbitrary keywords, or input values', () => {
    const result = mcpValidationFailure(
      new BadRequest('validation failed', [
        { instancePath: '/secret-field', keyword: 'secret-keyword' },
        null,
      ]),
      'agor_boards_get'
    )!;
    expect(result.content[0].text).not.toContain('secret-');
    const schema = z.object({ settings: z.record(z.string(), z.number()) });
    const parsed = schema.safeParse({ settings: { 'secret-key': 'secret-value' } });
    expect(inputValidationIssues(parsed.error, schema)).toEqual([
      { field: 'settings', code: 'invalid_type' },
    ]);
  });
  it('does not translate authorization or unrelated errors into validation failures', () => {
    for (const error of [
      new Forbidden('denied'),
      new BadRequest('other'),
      new Error('database unavailable'),
    ]) {
      expect(mcpValidationFailure(error, 'agor_boards_get')).toBeUndefined();
    }
  });
});
