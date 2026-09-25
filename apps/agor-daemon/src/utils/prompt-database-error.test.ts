import { Forbidden } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promptDatabaseErrorAround, safePromptDatabaseFailure } from './prompt-database-error.js';

const context = {} as HookContext;
afterEach(() => vi.restoreAllMocks());

describe('prompt database error boundary', () => {
  it.each(['40P01', '57014', '42501', 'CONNECTION_CLOSED', 'SQLITE_BUSY', undefined])(
    'sanitizes wrapped query failures, including missing SQLSTATE (%s), without replay',
    async (code) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const original = Object.assign(new Error('secret SQL params'), {
        query: 'SELECT secret',
        params: ['secret'],
        cause: { code, detail: 'secret', stack: 'secret' },
      });
      const next = vi.fn().mockRejectedValue(original);
      const failure = await promptDatabaseErrorAround(context, next).catch((error: Error) => error);
      expect(next).toHaveBeenCalledOnce();
      expect(failure).toHaveProperty('cause', original);
      expect(JSON.stringify(failure)).not.toMatch(/secret|SELECT|params|stack/);
      expect(JSON.stringify(failure)).toContain('reference');
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|SELECT|params|stack/);
      expect(log.mock.calls[0][0]).toContain(
        `sqlstate=${code && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown'}`
      );
    }
  );

  it('logs only an allowlisted lock target, not identifiers or arbitrary SQL', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = {
      query: 'SELECT 1 FROM "branches" WHERE "branches"."branch_id" = $1 FOR UPDATE',
      params: ['private-branch'],
      cause: {
        code: '40P01',
        detail:
          'Process 123 waits for ShareLock on transaction 456; blocked by process 789. Query: private graph',
      },
    };
    await promptDatabaseErrorAround(context, async () => {
      throw original;
    }).catch(() => {});
    expect(log.mock.calls[0][0]).toContain('lock_table=branches');
    expect(log.mock.calls[0][0]).toContain('deadlock_edges=123:456:789');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|SELECT|branch_id/);
  });

  it('preserves authorization errors and unrelated failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const error of [
      new Forbidden('denied'),
      new Error('model unavailable'),
      { cause: undefined },
    ]) {
      await expect(
        promptDatabaseErrorAround(context, async () => {
          throw error;
        })
      ).rejects.toBe(error);
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('does not log an already sanitized admission error twice', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = safePromptDatabaseFailure({ code: '40001' }, 10);
    await expect(
      promptDatabaseErrorAround(context, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(log).toHaveBeenCalledOnce();
  });

  it('handles cause cycles and passes through success', async () => {
    const cycle = { cause: {} };
    cycle.cause = cycle;
    await expect(
      promptDatabaseErrorAround(context, async () => {
        throw cycle;
      })
    ).rejects.toBe(cycle);
    await expect(promptDatabaseErrorAround(context, async () => {})).resolves.toBeUndefined();
  });
});
