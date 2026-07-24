import type { IncomingMessage } from 'node:http';
import type { AgorConfig } from '@agor/core/config';
import { resolveMultiTenancyConfig, resolveSecurity } from '@agor/core/config';
import type { CorsOptions } from 'cors';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { buildCorsConfig } from './cors';
import {
  createTenantAwareCorsMiddleware,
  createTenantAwareSocketCorsOptions,
  TenantCorsPolicyEngine,
  type TenantCorsPolicyStore,
} from './tenant-cors';

function engineFor(
  config: AgorConfig,
  tenantOrigins: Record<string, string[]>
): {
  engine: TenantCorsPolicyEngine;
  getOrigins: ReturnType<typeof vi.fn>;
} {
  const resolved = resolveSecurity(config).cors;
  const base = buildCorsConfig({ uiPort: 5173, daemonPort: 3030, resolved });
  const getOrigins = vi.fn(async (tenantId: string) => new Set(tenantOrigins[tenantId] ?? []));
  const store = { getOrigins } as unknown as TenantCorsPolicyStore;
  return {
    engine: new TenantCorsPolicyEngine({
      resolved,
      base,
      multiTenancy: resolveMultiTenancyConfig(config),
      getStore: () => store,
    }),
    getOrigins,
  };
}

function socketRequest(origin: string, tenantId: string): IncomingMessage {
  return {
    headers: { origin, 'x-tenant-id': tenantId, host: 'daemon.example.com' },
    socket: { encrypted: true },
  } as unknown as IncomingMessage;
}

function evaluateSocketCors(
  delegate: ReturnType<typeof createTenantAwareSocketCorsOptions>,
  request: IncomingMessage
): Promise<CorsOptions> {
  return new Promise((resolve, reject) => {
    delegate(request, (error, options) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(options ?? {});
    });
  });
}

async function evaluateHttpPreflight(
  middleware: ReturnType<typeof createTenantAwareCorsMiddleware>,
  origin: string,
  tenantId: string
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const headers: Record<string, string> = {
    origin,
    host: 'daemon.example.com',
    'x-tenant-id': tenantId,
    'access-control-request-method': 'PATCH',
  };
  const request = {
    method: 'OPTIONS',
    protocol: 'https',
    headers,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;

  return new Promise((resolve, reject) => {
    const responseHeaders = new Map<string, string>();
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string | number | readonly string[]) {
        responseHeaders.set(name.toLowerCase(), String(value));
        return this;
      },
      getHeader(name: string) {
        return responseHeaders.get(name.toLowerCase());
      },
      vary(name: string) {
        responseHeaders.set('vary', name);
        return this;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      type() {
        return this;
      },
      send(body: string) {
        finish(body);
        return this;
      },
      end() {
        finish('');
        return this;
      },
    } as unknown as Response & { statusCode: number };
    let settled = false;
    const finish = (body: string) => {
      if (settled) return;
      settled = true;
      resolve({
        statusCode: response.statusCode,
        headers: Object.fromEntries(responseHeaders),
        body,
      });
    };

    middleware(request, response, (error?: unknown) => {
      if (error) reject(error);
      else finish('');
    });
  });
}

describe('TenantCorsPolicyEngine', () => {
  it('keeps operator origins globally additive', async () => {
    const { engine, getOrigins } = engineFor(
      {
        security: {
          cors: {
            origins: ['https://operator.example.com'],
            tenant_origins: { enabled: true },
          },
        },
      },
      {}
    );
    await expect(engine.isOriginAllowed('https://operator.example.com', {})).resolves.toBe(true);
    expect(getOrigins).not.toHaveBeenCalled();
  });

  it('looks up only the tenant selected by trusted pre-auth routing', async () => {
    const { engine, getOrigins } = engineFor(
      {
        multi_tenancy: {
          mode: 'required_from_auth',
          auth_claim: 'tenant_id',
          trusted_header: 'x-tenant-id',
        },
        security: { cors: { tenant_origins: { enabled: true } } },
      },
      {
        'tenant-a': ['https://a.example.com'],
        'tenant-b': ['https://b.example.com'],
      }
    );

    await expect(
      engine.isOriginAllowed('https://a.example.com', { 'x-tenant-id': 'tenant-a' })
    ).resolves.toBe(true);
    await expect(
      engine.isOriginAllowed('https://a.example.com', { 'x-tenant-id': 'tenant-b' })
    ).resolves.toBe(false);
    expect(getOrigins).toHaveBeenNthCalledWith(1, 'tenant-a');
    expect(getOrigins).toHaveBeenNthCalledWith(2, 'tenant-b');
  });

  it('fails closed when required-mode routing context is missing', async () => {
    const { engine, getOrigins } = engineFor(
      {
        multi_tenancy: {
          mode: 'required_from_auth',
          auth_claim: 'tenant_id',
          trusted_header: 'x-tenant-id',
        },
        security: { cors: { tenant_origins: { enabled: true } } },
      },
      { 'tenant-a': ['https://a.example.com'] }
    );
    await expect(engine.isOriginAllowed('https://a.example.com', {})).resolves.toBe(false);
    expect(getOrigins).not.toHaveBeenCalled();
  });

  it('accepts the request target as same-origin without a configured entry', async () => {
    const { engine } = engineFor({}, {});
    await expect(
      engine.isOriginAllowed('https://app.example.com:443', {}, 'https://app.example.com')
    ).resolves.toBe(true);
  });
});

describe('createTenantAwareCorsMiddleware', () => {
  it('accepts and rejects HTTP preflight against the routed tenant, not a global union', async () => {
    const config: AgorConfig = {
      multi_tenancy: {
        mode: 'required_from_auth',
        auth_claim: 'tenant_id',
        trusted_header: 'x-tenant-id',
      },
      security: { cors: { tenant_origins: { enabled: true } } },
    };
    const { engine } = engineFor(config, {
      'tenant-a': ['https://a.example.com'],
      'tenant-b': ['https://b.example.com'],
    });
    const resolved = resolveSecurity(config).cors;
    const base = buildCorsConfig({ uiPort: 5173, daemonPort: 3030, resolved });
    const middleware = createTenantAwareCorsMiddleware(engine, base, resolved);

    await expect(
      evaluateHttpPreflight(middleware, 'https://a.example.com', 'tenant-a')
    ).resolves.toMatchObject({
      statusCode: 204,
      headers: {
        'access-control-allow-origin': 'https://a.example.com',
        'access-control-allow-credentials': 'true',
      },
    });
    await expect(
      evaluateHttpPreflight(middleware, 'https://a.example.com', 'tenant-b')
    ).resolves.toMatchObject({
      statusCode: 403,
      body: 'Not allowed by CORS',
    });
  });
});

describe('createTenantAwareSocketCorsOptions', () => {
  it('uses tenant routing for Engine.IO preflight policy', async () => {
    const config: AgorConfig = {
      multi_tenancy: {
        mode: 'required_from_auth',
        auth_claim: 'tenant_id',
        trusted_header: 'x-tenant-id',
      },
      security: { cors: { tenant_origins: { enabled: true } } },
    };
    const { engine } = engineFor(config, {
      'tenant-a': ['https://a.example.com'],
      'tenant-b': ['https://b.example.com'],
    });
    const resolved = resolveSecurity(config).cors;
    const base = buildCorsConfig({ uiPort: 5173, daemonPort: 3030, resolved });
    const delegate = createTenantAwareSocketCorsOptions(engine, base, resolved);

    await expect(
      evaluateSocketCors(delegate, socketRequest('https://a.example.com', 'tenant-a'))
    ).resolves.toMatchObject({ origin: true, credentials: true });
    await expect(
      evaluateSocketCors(delegate, socketRequest('https://a.example.com', 'tenant-b'))
    ).rejects.toThrow('Not allowed by CORS');
  });
});
