import { afterEach, describe, expect, it } from 'vitest';
import { runWithTenantContext } from '../db/tenant-context';
import {
  getLogContext,
  runWithLogContext,
  setLogContextField,
  setProcessLogContext,
} from './log-context';

afterEach(() => {
  setProcessLogContext({});
});

describe('log context', () => {
  it('drops invalid values', () => {
    runWithLogContext(
      {
        session_id: 'has space',
        task_id: 'user@example.com',
        branch_id: 'b'.repeat(129),
        user_id: 'u'.repeat(128),
      },
      () => {
        setLogContextField('tenant_id', 'bad value');
        expect(getLogContext()).toEqual({ user_id: 'u'.repeat(128) });
      }
    );
  });

  it('ignores unknown fields', () => {
    runWithLogContext({ secret: 'value' } as never, () => {
      setLogContextField('token' as never, 'value');
      expect(getLogContext()).toEqual({});
    });
  });

  it('is a no-op outside a scope', () => {
    setLogContextField('user_id', 'user-1');
    expect(getLogContext()).toEqual({});
  });

  it('ALS beats the process base, and the tenant scope beats both', () => {
    setProcessLogContext({ tenant_id: 'base-tenant', session_id: 'base-session', task_id: 'base' });
    expect(getLogContext()).toEqual({
      tenant_id: 'base-tenant',
      session_id: 'base-session',
      task_id: 'base',
    });
    runWithLogContext({ session_id: 'als-session', tenant_id: 'als-tenant' }, () => {
      expect(getLogContext()).toEqual({
        tenant_id: 'als-tenant',
        session_id: 'als-session',
        task_id: 'base',
      });
      runWithTenantContext('scope-tenant', () => {
        expect(getLogContext().tenant_id).toBe('scope-tenant');
      });
    });
  });

  it('does not leak across concurrent scopes', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    const run = (user: string) =>
      runWithLogContext({}, async () => {
        setLogContextField('user_id', user);
        await tick();
        const first = getLogContext().user_id;
        await tick();
        return [first, getLogContext().user_id];
      });
    const [a, b] = await Promise.all([run('user-a'), run('user-b')]);
    expect(a).toEqual(['user-a', 'user-a']);
    expect(b).toEqual(['user-b', 'user-b']);
    expect(getLogContext()).toEqual({});
  });

  it('nested scopes inherit and copy on enter', () => {
    runWithLogContext({ session_id: 'session-1', task_id: 'task-1' }, () => {
      runWithLogContext({}, () => {
        expect(getLogContext()).toEqual({ session_id: 'session-1', task_id: 'task-1' });
        setLogContextField('user_id', 'user-1');
        expect(getLogContext().user_id).toBe('user-1');
      });
      expect(getLogContext()).toEqual({ session_id: 'session-1', task_id: 'task-1' });
    });
  });
});
