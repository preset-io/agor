import { asMCPExternalError, MCPExternalError } from '@agor/core/mcp';
import { describe, expect, it, vi } from 'vitest';
import { MissingCredentialError } from '../../handlers/sdk/base-executor.js';
import {
  AgorSetupError,
  classifyClaudeResultFailure,
  isClaudeAbortError,
  logClaudeFailure,
  MESSAGES,
  sanitizeClaudeExecutionError,
} from './claude-error.js';

describe('Claude failure diagnosis', () => {
  it.each([
    ['Invalid API key', 'authentication'],
    ['Not logged in · Please run /login', 'authentication'],
    ['AccessDeniedException: denied bedrock:InvokeModel', 'authentication'],
    ['Could not load credentials from any providers', 'authentication'],
    ['OAuth token has expired', 'authentication'],
    ['Rate limit reached', 'rate_limit'],
    ['API Error: 429 Quota exceeded', 'rate_limit'],
    ['Quota exceeded', 'quota'],
    ['insufficient_quota', 'quota'],
    ['Credit balance is too low', 'credit_exhausted'],
    ['Overloaded', 'overloaded'],
  ])('normalizes exception/result forms of %s consistently', (text, category) => {
    const thrown = sanitizeClaudeExecutionError(
      Object.assign(new Error(`Claude Code returned an error result: ${text}`), {
        errorClass: 'error_result',
      })
    );
    const successError = classifyClaudeResultFailure({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: text,
    });
    const errorResult = classifyClaudeResultFailure({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [text],
    });
    expect(thrown).toMatchObject({ category });
    expect(successError).toMatchObject({ category, message: thrown.message });
    expect(errorResult).toMatchObject({ category, message: thrown.message });
    expect(thrown).not.toBeInstanceOf(MissingCredentialError);
    expect(errorResult).not.toBeInstanceOf(MissingCredentialError);
  });

  it.each([
    ['error_max_turns', 'turn_limit'],
    ['error_max_budget_usd', 'budget_limit'],
    ['error_max_structured_output_retries', 'structured_output_limit'],
  ])('uses authoritative result subtype %s before contradictory prose', (subtype, category) => {
    expect(
      classifyClaudeResultFailure({
        type: 'result',
        subtype,
        is_error: true,
        errors: ['Invalid API key'],
      })
    ).toMatchObject({ category });
  });

  it('never infers a failure from successful model output', () => {
    expect(
      classifyClaudeResultFailure({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Not logged in. Credit balance is too low',
      })
    ).toBeUndefined();
  });

  it('does not guess from conflicting or non-string error reasons', () => {
    for (const errors of [
      ['Invalid API key', 'Rate limit reached'],
      ['unknown', 'Credit balance is too low'],
      [{}],
    ]) {
      expect(
        classifyClaudeResultFailure({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors,
        })
      ).toMatchObject({ category: 'unknown' });
    }
  });

  it('does not let hostile result error fields interrupt accounting', () => {
    const getter = vi.fn(() => {
      throw new Error('SECRET');
    });
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    for (const errors of [
      revoked.proxy,
      Object.defineProperty({}, 'length', { get: getter }),
      Object.defineProperty([null], '0', { get: getter }),
    ]) {
      expect(
        classifyClaudeResultFailure({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors,
        })
      ).toMatchObject({ category: 'unknown' });
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('gives structured process failure priority over unrelated stderr', () => {
    const result = sanitizeClaudeExecutionError(
      Object.assign(
        new Error(
          'Claude Code process exited with code 1. stderr: MCP server: Not logged in. Please run /login'
        ),
        {
          errorClass: 'process_exited_nonzero',
          exitCode: 1,
        }
      )
    );
    expect(result).toMatchObject({
      category: 'process_failure',
      exitCode: 1,
      message: MESSAGES.processExit(1),
    });
    expect(result).not.toBeInstanceOf(MissingCredentialError);
  });

  it.each([401, 403, 429, 503, 529])(
    'prefers structured HTTP %s over conflicting prose',
    (status) => {
      expect(
        sanitizeClaudeExecutionError(
          Object.assign(new Error('Invalid API key: credit balance is too low'), { status })
        )
      ).toMatchObject({
        category:
          status === 401 || status === 403
            ? 'authentication'
            : status === 429
              ? 'rate_limit'
              : 'overloaded',
      });
    }
  );

  it('does not direct cloud quota failures to Anthropic billing', () => {
    const error = sanitizeClaudeExecutionError(
      Object.assign(new Error('Quota exceeded for requests per minute'), { status: 429 })
    );
    expect(error).toMatchObject({ category: 'rate_limit' });
    expect(error.message).not.toContain('Anthropic');
  });

  it.each([
    ['executable_not_found', MESSAGES.executableNotFound],
    ['executable_launch_failed', MESSAGES.executableLaunchFailed],
    ['spawn_failed', MESSAGES.spawnFailed],
    ['initialize_timeout', MESSAGES.initializeTimeout],
  ])('recognizes structured SDK startup failure %s', (errorClass, message) => {
    expect(sanitizeClaudeExecutionError({ errorClass, message: 'private path' })).toMatchObject({
      category: 'process_failure',
      message,
    });
  });

  it('preserves abort identity and locally authored setup errors', () => {
    for (const error of [
      Object.assign(new Error('stop'), { name: 'AbortError' }),
      { errorClass: 'aborted' },
    ]) {
      expect(isClaudeAbortError(error)).toBe(true);
      expect(sanitizeClaudeExecutionError(error)).toBe(error);
    }
    const setup = new AgorSetupError('Working directory unavailable');
    expect(sanitizeClaudeExecutionError(setup)).toBe(setup);
  });

  it('preserves genuine MCP failures but re-sanitizes transported lookalikes', () => {
    const original = asMCPExternalError(new Error('secret'), {
      stage: 'oauth',
      category: 'provider_rejected',
    });
    expect(sanitizeClaudeExecutionError(original)).toBe(original);
    const transported = {
      name: 'MCPExternalError',
      category: 'provider_rejected',
      diagnostic: { stage: 'oauth' },
      message: 'Bearer SECRET https://private',
    };
    const safe = sanitizeClaudeExecutionError(transported);
    expect(safe).toBeInstanceOf(MCPExternalError);
    expect(safe.message).toBe(original.message);
    expect(safe.message).not.toContain('SECRET');
  });

  it('does not reflect arbitrary diagnostic strings or invoke getters/coercion', () => {
    const getter = vi.fn(() => {
      throw new Error('SECRET');
    });
    const error = Object.defineProperty(
      { signal: 'SECRET', code: 'SECRET', errorClass: 'SECRET', toString: getter },
      'message',
      { get: getter }
    );
    const safe = sanitizeClaudeExecutionError(error);
    const logger = { error: vi.fn() };
    logClaudeFailure('test', safe, undefined, logger);
    expect(getter).not.toHaveBeenCalled();
    expect(safe.message).toBe(MESSAGES.unknown);
    expect(JSON.stringify(safe)).not.toContain('SECRET');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SECRET');
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => sanitizeClaudeExecutionError(revoked.proxy)).not.toThrow();
  });

  it('logs closed diagnostics, never a raw cause, local exception or setup message', () => {
    const logger = { error: vi.fn() };
    const raw = new Error('SECRET token https://private');
    const error = sanitizeClaudeExecutionError(
      Object.assign(raw, { errorClass: 'process_killed_by_signal', signal: 'SIGKILL' })
    );
    expect(error).toMatchObject({ category: 'process_failure', signal: 'SIGKILL' });
    expect(error.cause).toBe(raw);
    for (const item of [error, raw, new AgorSetupError('SECRET path')])
      logClaudeFailure('test', item, undefined, logger);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(error)).not.toContain('SECRET');
  });

  it.each(['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'EAGAIN', 'EMFILE', 'ENOMEM'])(
    'diagnoses bare process code %s without guessing which resource failed',
    (code) => {
      for (const text of [`spawn claude ${code} SECRET`, 'Invalid API key SECRET']) {
        const error = sanitizeClaudeExecutionError(Object.assign(new Error(text), { code }));
        expect(error).toMatchObject({
          category: 'process_failure',
          code,
          message: MESSAGES.processFailure,
        });
        expect(error.message).not.toContain('executable');
        expect(error.message).not.toContain('SECRET');
        expect(error).not.toBeInstanceOf(MissingCredentialError);
      }
    }
  );

  it('recognizes network codes without exposing endpoint text', () => {
    expect(
      sanitizeClaudeExecutionError(
        Object.assign(new Error('private endpoint'), { code: 'ECONNREFUSED' })
      )
    ).toMatchObject({ category: 'network', code: 'ECONNREFUSED', message: MESSAGES.network });
  });
});
