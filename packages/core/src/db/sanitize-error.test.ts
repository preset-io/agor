import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import { RepositoryError } from './repositories/base';
import { sanitizeDbError } from './sanitize-error';

describe('sanitizeDbError', () => {
  function drizzleFailure(): Error {
    const postgresError = Object.assign(
      new Error('duplicate key value violates unique constraint "sessions_schedule_run_unique"'),
      {
        code: '23505',
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
});
