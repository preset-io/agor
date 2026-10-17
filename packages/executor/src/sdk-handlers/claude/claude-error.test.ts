import { asMCPExternalError } from '@agor/core/mcp';
import { describe, expect, it, vi } from 'vitest';
import { MissingCredentialError } from '../../handlers/sdk/base-executor.js';
import {
  AgorSetupError,
  ClaudeExecutionError,
  ClaudeMissingCredentialError,
  isClaudeAbortError,
  logClaudeFailure,
  MESSAGES,
  sanitizeClaudeExecutionError,
} from './claude-error.js';

describe('sanitizeClaudeExecutionError', () => {
  it('classifies invalid API key as authentication failure (not missing credential)', () => {
    const error = Object.assign(
      new Error('Claude Code returned an error result: Invalid API key · Fix external API key'),
      { errorClass: 'error_result' }
    );
    const sanitized = sanitizeClaudeExecutionError(error);
    expect(sanitized).toBeInstanceOf(ClaudeExecutionError);
    expect((sanitized as ClaudeExecutionError).category).toBe('authentication');
    expect(sanitized.message).toBe(MESSAGES.authentication);
  });

  it('classifies Bedrock and Vertex cloud IAM failures as authentication', () => {
    const error = new Error(
      'AccessDeniedException: User is not authorized to perform: bedrock:InvokeModel'
    );
    const sanitized = sanitizeClaudeExecutionError(error);
    expect((sanitized as ClaudeExecutionError).category).toBe('authentication');
    expect(sanitized.message).toBe(MESSAGES.authentication);
  });

  it('classifies unauthenticated CLI state as missing credential', () => {
    const error = Object.assign(
      new Error('Claude Code returned an error result: Not logged in · Please run /login'),
      { errorClass: 'error_result' }
    );
    const sanitized = sanitizeClaudeExecutionError(error);
    expect(sanitized).toBeInstanceOf(ClaudeMissingCredentialError);
    expect((sanitized as ClaudeMissingCredentialError).category).toBe('missing_credential');
    expect(sanitized.message).toBe(MESSAGES.missingCredential);
  });

  it('prioritizes authentication when process exit code is also present', () => {
    const error = Object.assign(
      new Error('Claude Code process exited with code 1: Invalid API key'),
      { exitCode: 1, errorClass: 'process_exited_nonzero' }
    );
    const sanitized = sanitizeClaudeExecutionError(error);
    expect((sanitized as ClaudeExecutionError).category).toBe('authentication');
    expect(sanitized.message).toBe(MESSAGES.authentication);
  });

  it('prioritizes missing credential when process exit code is also present', () => {
    const error = Object.assign(
      new Error('Claude Code process exited with code 1: Not logged in. Please run /login'),
      { exitCode: 1, errorClass: 'process_exited_nonzero' }
    );
    const sanitized = sanitizeClaudeExecutionError(error);
    expect(sanitized).toBeInstanceOf(ClaudeMissingCredentialError);
    expect((sanitized as ClaudeMissingCredentialError).category).toBe('missing_credential');
  });

  it('classifies unadorned non-zero exit code as process failure', () => {
    const error = Object.assign(new Error('Claude Code process exited with code 137'), {
      exitCode: 137,
      errorClass: 'process_exited_nonzero',
    });
    const sanitized = sanitizeClaudeExecutionError(error);
    expect((sanitized as ClaudeExecutionError).category).toBe('process_failure');
    expect(sanitized.message).toBe(MESSAGES.processExit(137));
  });

  it('classifies process termination by signal', () => {
    const error = Object.assign(new Error('Killed'), {
      signal: 'SIGKILL',
      errorClass: 'process_killed_by_signal',
    });
    const sanitized = sanitizeClaudeExecutionError(error);
    expect((sanitized as ClaudeExecutionError).category).toBe('process_failure');
    expect(sanitized.message).toBe(MESSAGES.processSignal('SIGKILL'));
  });

  it('passes through genuine MCPExternalError unchanged', () => {
    const mcpError = asMCPExternalError(new Error('tool failure'), {
      stage: 'runtime',
      category: 'provider_unavailable',
    });
    expect(sanitizeClaudeExecutionError(mcpError)).toBe(mcpError);
  });

  it('passes through valid duck-typed MCPExternalError', () => {
    const transported = {
      name: 'MCPExternalError',
      category: 'provider_rejected',
      diagnostic: { stage: 'oauth', message: 'oauth expired' },
      message: 'The MCP operation failed: provider_rejected',
    };
    expect(sanitizeClaudeExecutionError(transported)).toBe(transported);
  });

  it('classifies structured HTTP status codes from API client or provider', () => {
    const err401 = Object.assign(new Error('upstream call failed'), { status: 401 });
    const res401 = sanitizeClaudeExecutionError(err401);
    expect((res401 as ClaudeExecutionError).category).toBe('authentication');
    expect(res401.message).toBe(MESSAGES.authentication);

    const err403 = Object.assign(new Error('forbidden access'), { statusCode: '403' });
    const res403 = sanitizeClaudeExecutionError(err403);
    expect((res403 as ClaudeExecutionError).category).toBe('authentication');
    expect(res403.message).toBe(MESSAGES.forbidden);

    const err429 = Object.assign(new Error('rate limited'), { status: 429 });
    expect((sanitizeClaudeExecutionError(err429) as ClaudeExecutionError).category).toBe(
      'rate_limit'
    );

    const err503 = Object.assign(new Error('service down'), { status: 503 });
    expect((sanitizeClaudeExecutionError(err503) as ClaudeExecutionError).category).toBe(
      'overloaded'
    );
  });

  it('re-sanitizes malformed duck-typed MCP lookalikes safely', () => {
    const wrongType = {
      name: 'MCPExternalError',
      category: 123,
      message: 'malformed lookalike',
    };
    expect((sanitizeClaudeExecutionError(wrongType) as ClaudeExecutionError).category).toBe(
      'unknown'
    );

    const unknownCategory = {
      name: 'MCPExternalError',
      category: 'invalid_category_name',
      diagnostic: { stage: 'runtime' },
    };
    expect((sanitizeClaudeExecutionError(unknownCategory) as ClaudeExecutionError).category).toBe(
      'unknown'
    );
  });

  it('prevents URLs, tokens, and filesystem paths from leaking in user-facing message', () => {
    const rawError = new Error(
      'Request failed at https://api.anthropic.com/v1/messages with Bearer sk-ant-api03-SECRETTOKEN in /home/user/repo'
    );
    const sanitized = sanitizeClaudeExecutionError(rawError);
    expect(sanitized.message).toBe(MESSAGES.unknown);
    expect(sanitized.message).not.toContain('https://');
    expect(sanitized.message).not.toContain('sk-ant');
    expect(sanitized.message).not.toContain('/home/');
    expect(sanitized.cause).toBe(rawError);
  });

  it('passes through AgorSetupError and MissingCredentialError', () => {
    const setupError = new AgorSetupError('Working directory unavailable');
    expect(sanitizeClaudeExecutionError(setupError)).toBe(setupError);

    const credError = new MissingCredentialError('Custom missing credential');
    const sanitizedCred = sanitizeClaudeExecutionError(credError);
    expect(sanitizedCred).toBeInstanceOf(ClaudeMissingCredentialError);
    expect(sanitizedCred.message).toBe('Custom missing credential');
  });
});

describe('isClaudeAbortError', () => {
  it('detects SDK abort structurally from errorClass', () => {
    expect(isClaudeAbortError({ errorClass: 'aborted' })).toBe(true);
    expect(isClaudeAbortError(Object.assign(new Error('aborted'), { errorClass: 'aborted' }))).toBe(
      true
    );
    expect(isClaudeAbortError(new Error('ordinary error'))).toBe(false);
    expect(isClaudeAbortError({ errorClass: 'error_result' })).toBe(false);
    expect(isClaudeAbortError(null)).toBe(false);
  });
});

describe('logClaudeFailure', () => {
  it('logs category, message, and diagnostic fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const err = new ClaudeExecutionError('process_failure', MESSAGES.processExit(137), {
        exitCode: 137,
        signal: 'SIGKILL',
      });
      logClaudeFailure('Failure label', err, { extra: true });
      expect(spy).toHaveBeenCalledWith('Failure label', {
        extra: true,
        category: 'process_failure',
        message: MESSAGES.processExit(137),
        exitCode: 137,
        signal: 'SIGKILL',
        errorClass: undefined,
        code: undefined,
      });

      const setupErr = new AgorSetupError('Working directory unavailable');
      logClaudeFailure('Setup failed', setupErr);
      expect(spy).toHaveBeenCalledWith('Setup failed', {
        category: 'setup_error',
        message: 'Working directory unavailable',
        exitCode: undefined,
        signal: undefined,
        errorClass: undefined,
        code: undefined,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
