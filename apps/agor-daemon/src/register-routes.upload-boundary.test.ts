import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTenantScopedDatabaseProxy, runWithTenantDatabaseScope } from '@agor/core/db';
import { type TenantContext, UPLOAD_REQUEST_ID_HEADER } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { appendResponseHeaderValue, createUploadAuthMiddleware } from './register-routes.js';

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

  it('preserves existing exposed headers alongside the correlation header', () => {
    expect(appendResponseHeaderValue('X-Existing-Header', UPLOAD_REQUEST_ID_HEADER)).toBe(
      `X-Existing-Header, ${UPLOAD_REQUEST_ID_HEADER}`
    );
    expect(
      appendResponseHeaderValue(
        `X-Existing-Header, ${UPLOAD_REQUEST_ID_HEADER.toUpperCase()}`,
        UPLOAD_REQUEST_ID_HEADER
      )
    ).toBe(`X-Existing-Header, ${UPLOAD_REQUEST_ID_HEADER.toUpperCase()}`);
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

  it('propagates the tenant verified by authentication on the same params object', async () => {
    const verifiedTenant = { tenant_id: 'verified-tenant', source: 'explicit' } as TenantContext;
    const rawDb = { run: vi.fn(), select: vi.fn(() => ({ user_id: 'user-1' })) };
    const guardedDb = createTenantScopedDatabaseProxy(rawDb as never, {
      requireScope: true,
      label: 'upload authentication test database',
    });
    let suppliedParams: unknown;
    const authentication = {
      create: vi.fn(async (_data, params) => {
        suppliedParams = params;
        params.tenant = verifiedTenant;
        const user = await runWithTenantDatabaseScope(guardedDb, params.tenant.tenant_id, () =>
          guardedDb.select()
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
        static_tenant_id: 'static-tenant',
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
    expect(req.feathers.tenant).toBe(verifiedTenant);
    expect(rawDb.select).toHaveBeenCalledOnce();
  });

  it('fails closed when hosted authentication establishes no tenant identity', async () => {
    const authentication = {
      create: vi.fn(async () => ({
        user: { user_id: 'user-1' },
        authentication: { payload: {} },
      })),
    };
    const middleware = createUploadAuthMiddleware({
      authentication,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'static-tenant',
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
    const routeEnd = source.indexOf('const authorizeUpload', routeStart);
    const helper = source.slice(helperStart, middlewareStart);
    const executorRoutes = source.slice(routeStart, routeEnd);

    expect(helperStart).toBeGreaterThan(0);
    expect(helper).toContain('const authParams: AuthenticatedParams');
    expect(helper).toMatch(/authentication\.create\([\s\S]*authParams\s*\)/);
    expect(helper).toContain('authParams.tenant ??');
    expect(executorRoutes.match(/authenticateBearerHttpRequest\(/g)).toHaveLength(2);
  });
});
