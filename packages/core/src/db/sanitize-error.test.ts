import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import { RepositoryError } from './repositories/base';
import {
  formatSanitizedDbError,
  isDatabaseUniqueConstraintError,
  sanitizeDbError,
} from './sanitize-error';

describe('sanitizeDbError', () => {
  function drizzleFailure(): Error {
    const postgresError = Object.assign(
      new Error('duplicate key value violates unique constraint "sessions_schedule_run_unique"'),
      {
        code: '23505',
        routine: 'json_errsave_error',
        constraint_name: 'sessions_schedule_run_unique',
        detail: 'Key (rendered_prompt)=(SECRET_SENTINEL) already exists',
      }
    );
    return Object.assign(
      new Error('Failed query: insert into sessions (...) values (...)\nparams: SECRET_SENTINEL'),
      {
        name: 'DrizzleQueryError',
        query: 'insert into sessions (...) values (...)',
        params: ['SECRET_SENTINEL'],
        cause: postgresError,
      }
    );
  }

  it('retains useful database metadata without statement values or nested causes', () => {
    const output = inspect(sanitizeDbError(drizzleFailure()));

    expect(output).not.toContain('SECRET_SENTINEL');
    expect(output).not.toContain('insert into sessions');
    expect(output).not.toContain('cause');
    expect(output).toContain('Database constraint violation');
    expect(output).toContain('sessions_schedule_run_unique');
    expect(output).toContain('23505');
    expect(output).toContain('json_errsave_error');
    expect(output.length).toBeLessThan(1024);
  });

  it('formats only allowlisted metadata for command diagnostics', () => {
    const diagnostic = formatSanitizedDbError(sanitizeDbError(drizzleFailure()));
    expect(diagnostic).toBe(
      'Database constraint violation (code=23505 constraint=sessions_schedule_run_unique routine=json_errsave_error)'
    );
    expect(diagnostic).not.toContain('SECRET_SENTINEL');
  });

  it('sanitizes RepositoryError output without changing its cause semantics', () => {
    const failure = drizzleFailure();
    const wrapped = new RepositoryError(`Failed to create session: ${failure.message}`, failure);
    const output = inspect(sanitizeDbError(wrapped));

    expect(output).not.toContain('SECRET_SENTINEL');
    expect(output).not.toContain('insert into sessions');
    expect(output).toContain('sessions_schedule_run_unique');
    expect(wrapped.cause).toBe(failure);
  });

  it('does not trust root or nested driver messages', () => {
    const nested = Object.assign(new Error('invalid uuid: "SECRET_SENTINEL"'), {
      code: '22P02',
    });
    const root = Object.assign(new Error('SECRET_SENTINEL'), { cause: nested });
    const output = inspect(sanitizeDbError(root));

    expect(output).not.toContain('SECRET_SENTINEL');
    expect(output).toContain('Database operation failed');
    expect(output).toContain('22P02');
  });

  it('does not format large query parameters or secret-like tool output', () => {
    const secret = 'sk-secret-sentinel';
    const failure = Object.assign(new Error(`Failed query\nparams: ${secret}`), {
      params: [{ tool_result: `${secret}${'PK\\x00'.repeat(300_000)}` }],
      cause: Object.assign(new Error('invalid JSON parameter'), {
        code: '22P05',
        routine: 'json_errsave_error',
      }),
    });
    const output = inspect(sanitizeDbError(failure));
    expect(output).not.toContain(secret);
    expect(output).not.toContain('PK');
    expect(output).toContain('22P05');
    expect(output).toContain('json_errsave_error');
    expect(output.length).toBeLessThan(1024);
  });

  it('only includes strictly validated database metadata', () => {
    const output = inspect(
      sanitizeDbError({
        name: 'SECRET_SENTINEL',
        code: 'SECRET_SENTINEL',
        constraint: 'SECRET_SENTINEL\nforged-log-line',
      })
    );

    expect(output).not.toContain('SECRET_SENTINEL');
    expect(output).not.toContain('forged-log-line');
    expect(output).toContain("name: 'DatabaseError'");
    expect(output).not.toContain('code:');
    expect(output).not.toContain('constraint:');
  });
});

describe('isDatabaseUniqueConstraintError', () => {
  it('recognizes wrapped PostgreSQL and SQLite unique violations', () => {
    expect(isDatabaseUniqueConstraintError({ cause: { code: '23505' } })).toBe(true);
    expect(isDatabaseUniqueConstraintError({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true);
    expect(
      isDatabaseUniqueConstraintError({
        code: 'SQLITE_CONSTRAINT',
        message: 'UNIQUE constraint failed: sessions.session_id',
      })
    ).toBe(true);
  });

  it('does not classify other constraint or validation failures as unique', () => {
    expect(isDatabaseUniqueConstraintError({ code: '23503' })).toBe(false);
    expect(
      isDatabaseUniqueConstraintError({
        code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
        message: 'FOREIGN KEY constraint failed',
      })
    ).toBe(false);
    expect(isDatabaseUniqueConstraintError(new Error('model validation failed'))).toBe(false);
  });
});
