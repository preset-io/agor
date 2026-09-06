import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTenantScopedDatabaseProxy,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Branch, Session, TenantContext, User, UUID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createUploadAuthMiddleware, resolveUploadPromptAccess } from './register-routes.js';

describe('browser upload route boundary ordering', () => {
  const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');

  it('authenticates and authorizes before the multipart parser can accept bytes', () => {
    const route = source.slice(source.indexOf("'/sessions/:sessionId/upload'"));
    expect(route.indexOf('uploadAuthMiddleware')).toBeLessThan(
      route.indexOf("uploadMiddleware.array('files'")
    );
    expect(route.indexOf('authorizeUpload')).toBeLessThan(
      route.indexOf("uploadMiddleware.array('files'")
    );
  });

  it('does not expose Multer buffers or physical file paths in the response contract', () => {
    const handler = source.slice(
      source.indexOf('const uploadHandler'),
      source.indexOf('const uploadLogger')
    );
    expect(handler).not.toContain('f.buffer');
    expect(handler).not.toContain('f.path');
    expect(handler).toContain('ref: staged.ref');
  });

  it('classifies an authenticated upload notification as a direct human prompt', () => {
    const handler = source.slice(
      source.indexOf('const uploadHandler'),
      source.indexOf('const uploadLogger')
    );
    expect(handler).toContain("{ prompt: promptText, messageSource: 'agor' }");
  });

  it('propagates the tenant verified by authentication on the same params object', async () => {
    const verifiedTenant = { tenant_id: 'verified-tenant', source: 'explicit' } as TenantContext;
    const verifiedUser = { user_id: 'user-1' } as User;
    const rawDb = { run: vi.fn(), select: vi.fn(() => verifiedUser) };
    const guardedDb = createTenantScopedDatabaseProxy(rawDb as never, {
      requireScope: true,
      label: 'upload authentication test database',
    });
    let suppliedParams: unknown;
    const authentication = {
      create: vi.fn(async (_data, params) => {
        suppliedParams = params;
        params.tenant = verifiedTenant;
        const user = await runWithTenantDatabaseScope(
          guardedDb,
          params.tenant.tenant_id,
          async () => {
            guardedDb.select();
            return verifiedUser;
          }
        );
        return {
          user,
          authentication: { payload: { tenant_id: 'payload-tenant' } },
        };
      }),
    };
    const middleware = createUploadAuthMiddleware({
      authentication,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'static-tenant' as TenantContext['tenant_id'],
        auth_claim: 'tenant_id',
        trusted_header: 'x-tenant-id',
      },
    });
    const req = {
      headers: { authorization: 'Bearer token', 'x-tenant-id': 'header-tenant' },
      feathers: undefined as { tenant?: TenantContext } | undefined,
    };
    const res = {};
    const next = vi.fn();

    await middleware(req, res, next);

    const passedParams = authentication.create.mock.calls[0]?.[1];
    expect(suppliedParams).toBe(passedParams);
    expect(next).toHaveBeenCalledOnce();
    expect(req.feathers?.tenant).toBe(verifiedTenant);
    expect(rawDb.select).toHaveBeenCalledOnce();
  });

  it('fails closed when hosted authentication establishes no tenant identity', async () => {
    const authentication = {
      create: vi.fn(async () => ({
        user: { user_id: 'user-1' } as User,
        authentication: { payload: {} },
      })),
    };
    const middleware = createUploadAuthMiddleware({
      authentication,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'static-tenant' as TenantContext['tenant_id'],
        auth_claim: 'tenant_id',
      },
    });
    const req = {
      headers: { authorization: 'Bearer token' },
      feathers: undefined,
    };
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const next = vi.fn();

    await middleware(req, { status }, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(req.feathers).toBeUndefined();
  });

  it('centralizes tenant-aware bearer authentication for upload and executor data planes', () => {
    const helperStart = source.indexOf('export async function authenticateBearerHttpRequest');
    const middlewareStart = source.indexOf('export function createUploadAuthMiddleware');
    const routeStart = source.indexOf("'/executor/uploads/:uploadRef/content'");
    const routeEnd = source.indexOf('const DEBUG_UPLOAD', routeStart);
    const helper = source.slice(helperStart, middlewareStart);
    const executorRoutes = source.slice(routeStart, routeEnd);

    expect(helperStart).toBeGreaterThan(0);
    expect(helper).toContain('const authParams: AuthenticatedParams');
    expect(helper).toMatch(/authentication\.create\([\s\S]*authParams\s*\)/);
    expect(helper).toContain('authParams.tenant ??');
    expect(executorRoutes.match(/authenticateBearerHttpRequest\(/g)).toHaveLength(2);
  });
});

describe('upload prompt authorization tenant scope', () => {
  function fixture() {
    const rawDb = { run: vi.fn(), select: vi.fn(() => getCurrentTenantId()) };
    const db = createTenantScopedDatabaseProxy(rawDb as never, {
      requireScope: true,
      label: 'upload authorization test database',
    });
    const session = {
      session_id: 'session-a',
      branch_id: 'branch-a',
      created_by: 'user-a',
      sdk_home_scope: 'branch',
    } as Session;
    const branchRepository: Parameters<typeof resolveUploadPromptAccess>[0]['branchRepository'] = {
      findById: vi.fn(async () => {
        db.select();
        return getCurrentTenantId() === 'tenant-a'
          ? ({ branch_id: session.branch_id } as Branch)
          : null;
      }),
      resolveUserPermission: vi.fn(async () => {
        expect(db.select()).toBe('tenant-a');
        return 'session' as const;
      }),
      resolveSessionPromptAuthority: vi.fn(async (_branchId, userId) => {
        expect(db.select()).toBe('tenant-a');
        return {
          allowed: userId === 'user-a',
          source: userId === 'user-a' ? ('own_session' as const) : ('denied' as const),
        };
      }),
    };
    const authorize = (tenantId: TenantContext['tenant_id'], userId = 'user-a') =>
      resolveUploadPromptAccess({
        db,
        tenantId,
        branchRepository,
        session,
        userId: userId as UUID,
      });
    return { authorize, branchRepository, rawDb };
  }

  it('keeps every branch permission query in tenant scope after branch lookup', async () => {
    const { authorize, rawDb } = fixture();
    await expect(authorize('tenant-a' as TenantContext['tenant_id'])).resolves.toMatchObject({
      allowed: true,
    });
    expect(rawDb.select).toHaveBeenCalledTimes(3);
    expect(getCurrentTenantId()).toBeUndefined();
  });

  it('does not resolve prompt authority for another tenant’s branch', async () => {
    const { authorize, branchRepository } = fixture();
    await expect(authorize('tenant-b' as TenantContext['tenant_id'])).resolves.toBeNull();
    expect(branchRepository.resolveUserPermission).not.toHaveBeenCalled();
    expect(branchRepository.resolveSessionPromptAuthority).not.toHaveBeenCalled();
  });

  it('preserves a same-tenant caller’s prompt denial', async () => {
    const { authorize } = fixture();
    await expect(
      authorize('tenant-a' as TenantContext['tenant_id'], 'user-b')
    ).resolves.toMatchObject({ allowed: false });
  });
});
