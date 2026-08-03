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
    expect(output).toContain('duplicate key value violates unique constraint');
    expect(output).toContain('sessions_schedule_run_unique');
    expect(output).toContain('23505');
  });

  it('sanitizes RepositoryError messages and causes at the repository boundary', () => {
    const failure = drizzleFailure();
    const wrapped = new RepositoryError(`Failed to create session: ${failure.message}`, failure);
    const output = inspect(wrapped);

    expect(output).not.toContain('SECRET_SENTINEL');
    expect(output).not.toContain('insert into sessions');
    expect(output).toContain('sessions_schedule_run_unique');
    expect(output).toContain('Failed to create session');
  });
});
