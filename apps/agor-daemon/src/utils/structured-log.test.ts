import { describe, expect, it } from 'vitest';
import { formatStructuredLog, structuredLogErrorCode } from './structured-log.js';

describe('structured operational logs', () => {
  it('formats bounded key=value fields and skips undefined values', () => {
    expect(
      formatStructuredLog('[component]', {
        event: 'started',
        id: 'abc 123',
        count: 2,
        enabled: true,
        omitted: undefined,
      })
    ).toBe('[component] event="started" id="abc 123" count=2 enabled=true');
  });

  it('extracts only bounded error codes through causes', () => {
    const error = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('inner'), { code: 'SQLITE_BUSY' }),
    });

    expect(structuredLogErrorCode(error)).toBe('SQLITE_BUSY');
    expect(structuredLogErrorCode(new Error('raw message is not logged'))).toBe('operation_failed');
  });
});
