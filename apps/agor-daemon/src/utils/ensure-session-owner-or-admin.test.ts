/**
 * RBAC tests for `ensureSessionOwnerOrAdmin` — the hook that gates
 * `session_env_selections` mutations.
 *
 * Only the session's creator (or a global admin/superadmin) may modify these
 * selections. Worktree-level `all` permission does NOT grant access — the
 * selections expose the creator's private credentials.
 */

import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { ROLES } from '@agor/core/types';
import type { HookContext } from '@feathersjs/feathers';
import { describe, expect, it } from 'vitest';
import { ensureSessionOwnerOrAdmin } from './worktree-authorization';

function makeContext(opts: {
  provider?: string;
  user?: { user_id: string; role?: string; _isServiceAccount?: boolean };
  session?: { created_by: string };
}): HookContext {
  return {
    params: {
      provider: opts.provider,
      user: opts.user,
      session: opts.session,
    },
  } as unknown as HookContext;
}

describe('ensureSessionOwnerOrAdmin', () => {
  const hook = ensureSessionOwnerOrAdmin();

  it('passes for internal calls (no provider)', () => {
    const ctx = makeContext({ session: { created_by: 'anyone' } });
    expect(() => hook(ctx)).not.toThrow();
  });

  it('passes for service accounts regardless of session creator', () => {
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: 'exec-sa', _isServiceAccount: true },
      session: { created_by: 'someone-else' },
    });
    expect(() => hook(ctx)).not.toThrow();
  });

  it('passes for the session creator', () => {
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: 'alice', role: ROLES.MEMBER },
      session: { created_by: 'alice' },
    });
    expect(() => hook(ctx)).not.toThrow();
  });

  it('passes for admins even when not the creator', () => {
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: 'admin-1', role: ROLES.ADMIN },
      session: { created_by: 'alice' },
    });
    expect(() => hook(ctx)).not.toThrow();
  });

  it('passes for superadmins even when not the creator', () => {
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: 'super-1', role: ROLES.SUPERADMIN },
      session: { created_by: 'alice' },
    });
    expect(() => hook(ctx)).not.toThrow();
  });

  it('denies a member who is not the creator (worktree access irrelevant)', () => {
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: 'bob', role: ROLES.MEMBER },
      session: { created_by: 'alice' },
    });
    expect(() => hook(ctx)).toThrow(Forbidden);
  });

  it('denies viewers', () => {
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: 'bob', role: ROLES.VIEWER },
      session: { created_by: 'alice' },
    });
    expect(() => hook(ctx)).toThrow(Forbidden);
  });

  it('throws NotAuthenticated when the user is absent', () => {
    const ctx = makeContext({
      provider: 'rest',
      session: { created_by: 'alice' },
    });
    expect(() => hook(ctx)).toThrow(NotAuthenticated);
  });

  it('throws if session has not been loaded onto params', () => {
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: 'alice', role: ROLES.MEMBER },
    });
    expect(() => hook(ctx)).toThrow(/loadSession/);
  });

  it('allowSuperadmin: false blocks superadmins', () => {
    const strict = ensureSessionOwnerOrAdmin({ allowSuperadmin: false });
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: 'super-1', role: ROLES.SUPERADMIN },
      session: { created_by: 'alice' },
    });
    expect(() => strict(ctx)).toThrow(Forbidden);
  });
});
