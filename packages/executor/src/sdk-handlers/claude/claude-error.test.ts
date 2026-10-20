import { asMCPExternalError, MCPExternalError } from '@agor/core/mcp';
import { describe, expect, it, vi } from 'vitest';
import { MissingCredentialError } from '../../handlers/sdk/base-executor.js';
import {
  AgorSetupError,
  ClaudeExecutionError,
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

describe('structured Claude provider failure fields', () => {
  const SENTINEL = 'SENTINEL-provider-text sk-ant-secret';

  it('maps api_error_status 401 to authentication with httpStatus 401', () => {
    expect(
      classifyClaudeResultFailure({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 401,
        result: SENTINEL,
      })
    ).toMatchObject({ category: 'authentication', httpStatus: 401 });
  });

  it('maps billing_error to credit_exhausted', () => {
    expect(
      classifyClaudeResultFailure(
        { type: 'result', subtype: 'success', is_error: true, result: SENTINEL },
        { assistantError: 'billing_error' }
      )
    ).toMatchObject({ category: 'credit_exhausted', providerError: 'billing_error' });
  });

  it.each([
    ['authentication_failed', 'authentication'],
    ['oauth_org_not_allowed', 'authentication'],
    ['rate_limit', 'rate_limit'],
    ['overloaded', 'overloaded'],
    ['server_error', 'overloaded'],
  ])('maps assistant error %s to %s', (assistantError, category) => {
    expect(
      classifyClaudeResultFailure(
        { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] },
        { assistantError }
      )
    ).toMatchObject({ category, providerError: assistantError });
  });

  it('keeps an unmapped SDK class as a field without guessing a category', () => {
    expect(
      classifyClaudeResultFailure(
        { type: 'result', subtype: 'success', is_error: true, result: 'opaque' },
        { assistantError: 'model_not_found' }
      )
    ).toMatchObject({ category: 'unknown', providerError: 'model_not_found' });
  });

  it('ignores an unknown msg.error string', () => {
    const failure = classifyClaudeResultFailure(
      { type: 'result', subtype: 'success', is_error: true, result: 'opaque' },
      { assistantError: 'invalid_api_key SENTINEL' }
    );
    expect(failure?.category).toBe('unknown');
    expect(failure?.providerError).toBeUndefined();
  });

  it('ignores an out-of-range api_error_status', () => {
    const failure = classifyClaudeResultFailure({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 4010,
      result: 'opaque',
    });
    expect(failure?.httpStatus).toBeUndefined();
  });

  it('records a structured exception status, never one parsed from prose', () => {
    expect(
      sanitizeClaudeExecutionError(Object.assign(new Error(SENTINEL), { status: 429 }))
    ).toMatchObject({ category: 'rate_limit', httpStatus: 429 });
    const parsed = sanitizeClaudeExecutionError(new Error('API Error: 401 bad key'));
    expect(parsed).toMatchObject({ category: 'authentication' });
    expect(parsed).not.toHaveProperty('httpStatus', 401);
  });

  it('never logs result or errors text', () => {
    const logger = { error: vi.fn() };
    for (const result of [
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 401,
        result: SENTINEL,
      },
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [SENTINEL] },
    ]) {
      const failure = classifyClaudeResultFailure(result, { assistantError: 'rate_limit' });
      logClaudeFailure('[claude.query] result_failed', failure, { messageCount: 1 }, logger);
      expect(JSON.stringify(failure)).not.toContain('SENTINEL');
    }
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SENTINEL');
  });

  it('logClaudeFailure renders key=value', () => {
    const logger = { error: vi.fn() };
    const failure = classifyClaudeResultFailure(
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 401,
        result: SENTINEL,
      },
      { assistantError: 'authentication_failed' }
    );
    const label = '[claude.query] result_failed subtype=success';
    const sessionId = '01a159c9-49e5-770b-bc18-187b39237d68';
    const taskId = '01a159ca-0000-7000-8000-000000000001';
    logClaudeFailure(
      label,
      failure,
      { messageCount: 3, hasStderr: false, sessionId, taskId },
      logger
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    const args = logger.error.mock.calls[0];
    expect(args).toHaveLength(1);
    expect(typeof args[0]).toBe('string');
    const line = args[0] as string;
    expect(line.startsWith(`${label} `)).toBe(true);
    expect(line.slice(label.length)).toMatch(/^( [a-z_]+=[^ ]+)+$/);
    expect(line).toContain(
      'category=authentication http_status=401 provider_error=authentication_failed'
    );
    expect(line).toContain(
      `message_count=3 has_stderr=false session_id=${sessionId} task_id=${taskId}`
    );
    expect(line).not.toContain('SENTINEL');

    logClaudeFailure(label, failure, { sessionId }, logger);
    const withoutTask = logger.error.mock.calls[1][0] as string;
    expect(withoutTask).toContain(`session_id=${sessionId}`);
    expect(withoutTask).not.toContain('task_id=');
  });

  it('renders every failure shape as one key=value string', () => {
    const logger = { error: vi.fn() };
    const mcp = asMCPExternalError(new Error(SENTINEL), { stage: 'runtime' });
    for (const error of [
      new ClaudeExecutionError('network', MESSAGES.network, { code: 'ECONNRESET' }),
      mcp,
      new AgorSetupError(SENTINEL),
      new Error(SENTINEL),
    ]) {
      logClaudeFailure('[claude.query] setup_failed', error, undefined, logger);
    }
    for (const [line, ...rest] of logger.error.mock.calls) {
      expect(rest).toEqual([]);
      expect((line as string).slice('[claude.query] setup_failed'.length)).toMatch(
        /^( [a-z_]+=[^ ]+)+$/
      );
    }
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SENTINEL');
  });
});
