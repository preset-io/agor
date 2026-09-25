import { describe, expect, it } from 'vitest';
import { describeCodexErrorInfo, readCodexErrorInfo } from './error-info';

describe('readCodexErrorInfo', () => {
  it.each([
    [{ error: { message: 'x', codex_error_info: 'usage_limit_exceeded' } }, 'usage_limit_exceeded'],
    [{ error: { message: 'x', codexErrorInfo: 'usageLimitExceeded' } }, 'usage_limit_exceeded'],
    [{ type: 'error', message: 'x', codex_error_info: 'cyber_policy' }, 'cyber_policy'],
    [{ codex_error_info: 'unauthorized' }, 'unauthorized'],
  ])('reads unit variants from %j', (source, variant) => {
    expect(readCodexErrorInfo(source)).toEqual({ variant });
  });

  it('reads struct variants with their HTTP status in either casing', () => {
    expect(
      readCodexErrorInfo({
        error: {
          codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } },
        },
      })
    ).toEqual({ variant: 'response_too_many_failed_attempts', httpStatus: 429 });
    expect(
      readCodexErrorInfo({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } } })
    ).toEqual({ variant: 'http_connection_failed' });
  });

  it('ignores unknown variants, prose, and message-only errors', () => {
    expect(readCodexErrorInfo({ error: { message: "You've hit your usage limit." } })).toBe(
      undefined
    );
    expect(readCodexErrorInfo({ codex_error_info: 'SENTINEL_made_up' })).toBe(undefined);
    expect(readCodexErrorInfo({ codex_error_info: { a: {}, b: {} } })).toBe(undefined);
    expect(
      readCodexErrorInfo({
        codex_error_info: { http_connection_failed: { http_status_code: 9999 } },
      })
    ).toEqual({ variant: 'http_connection_failed' });
    expect(readCodexErrorInfo(undefined)).toBe(undefined);
  });

  it('never invokes accessors', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'codex_error_info', {
      get() {
        throw new Error('getter invoked');
      },
    });
    expect(readCodexErrorInfo(hostile)).toBe(undefined);
  });
});

describe('describeCodexErrorInfo', () => {
  it('renders fixed copy with only closed values', () => {
    expect(describeCodexErrorInfo('Lead', { variant: 'usage_limit_exceeded' })).toMatch(
      /^Lead: the Codex account reached its usage limit/
    );
    expect(
      describeCodexErrorInfo('Lead', { variant: 'rate_limit_exceeded', httpStatus: 429 })
    ).toMatch(/^Lead \(HTTP 429\): /);
  });

  it('keeps the generic message for unexplained variants', () => {
    expect(describeCodexErrorInfo('Lead', { variant: 'other' })).toBeUndefined();
    expect(describeCodexErrorInfo('Lead', undefined)).toBeUndefined();
  });
});
