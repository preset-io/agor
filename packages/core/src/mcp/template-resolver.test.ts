import { describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { MCPServer, MCPServerID } from '../types';
import {
  buildMCPTemplateContext,
  buildMCPTemplateContextFromEnv,
  resolveMcpServerEnv,
  resolveMcpServerTemplates,
} from './template-resolver';

/** Helper to create test MCPServer objects with required fields */
function createTestServer(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    mcp_server_id: generateId() as MCPServerID,
    name: 'test-server',
    transport: 'stdio',
    scope: 'global',
    enabled: true,
    source: 'user',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('buildMCPTemplateContextFromEnv', () => {
  it('should only include user-defined env vars (from AGOR_USER_ENV_KEYS)', () => {
    const env = {
      AGOR_USER_ENV_KEYS: 'GITHUB_TOKEN,API_KEY',
      GITHUB_TOKEN: 'gh_secret123',
      API_KEY: 'api_secret456',
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      AGOR_MASTER_SECRET: 'should_not_be_exposed',
    };

    const context = buildMCPTemplateContextFromEnv(env);

    // Only user-defined vars should be present
    expect(context.user.env).toEqual({
      GITHUB_TOKEN: 'gh_secret123',
      API_KEY: 'api_secret456',
    });

    // System vars should NOT be present
    expect(context.user.env.PATH).toBeUndefined();
    expect(context.user.env.HOME).toBeUndefined();
    expect(context.user.env.AGOR_MASTER_SECRET).toBeUndefined();
  });

  it('should return empty env when AGOR_USER_ENV_KEYS is not set', () => {
    const env = {
      GITHUB_TOKEN: 'gh_secret123',
      PATH: '/usr/bin:/bin',
    };

    const context = buildMCPTemplateContextFromEnv(env);

    expect(context.user.env).toEqual({});
  });

  it('should handle missing env vars gracefully', () => {
    const env = {
      AGOR_USER_ENV_KEYS: 'GITHUB_TOKEN,MISSING_VAR',
      GITHUB_TOKEN: 'gh_secret123',
      // MISSING_VAR is not set
    };

    const context = buildMCPTemplateContextFromEnv(env);

    expect(context.user.env).toEqual({
      GITHUB_TOKEN: 'gh_secret123',
    });
  });
});

describe('resolveMcpServerEnv', () => {
  const context = {
    user: {
      env: {
        GITHUB_TOKEN: 'gh_secret123',
        API_KEY: 'api_key_456',
      },
    },
  };

  it('should resolve templated env vars', () => {
    const envTemplate = {
      GITHUB_TOKEN: '{{ user.env.GITHUB_TOKEN }}',
      STATIC_VAR: 'static_value',
    };

    const resolved = resolveMcpServerEnv(envTemplate, context);

    expect(resolved).toEqual({
      GITHUB_TOKEN: 'gh_secret123',
      STATIC_VAR: 'static_value',
    });
  });

  it('should exclude env vars that resolve to empty', () => {
    const envTemplate = {
      GITHUB_TOKEN: '{{ user.env.GITHUB_TOKEN }}',
      MISSING: '{{ user.env.NONEXISTENT }}',
    };

    const resolved = resolveMcpServerEnv(envTemplate, context);

    expect(resolved).toEqual({
      GITHUB_TOKEN: 'gh_secret123',
    });
    expect(resolved?.MISSING).toBeUndefined();
  });

  it('should return undefined when all env vars resolve to empty', () => {
    const envTemplate = {
      MISSING1: '{{ user.env.NONEXISTENT1 }}',
      MISSING2: '{{ user.env.NONEXISTENT2 }}',
    };

    const resolved = resolveMcpServerEnv(envTemplate, context);

    expect(resolved).toBeUndefined();
  });
});

describe('resolveMcpServerTemplates', () => {
  const context = {
    user: {
      env: {
        GITHUB_TOKEN: 'gh_secret123',
        API_URL: 'https://api.example.com',
        BEARER_TOKEN: 'bearer_xyz',
      },
    },
  };

  it('should resolve url templates', () => {
    const server = createTestServer({
      name: 'test-server',
      transport: 'sse',
      url: '{{ user.env.API_URL }}/mcp',
    });

    const result = resolveMcpServerTemplates(server, context);

    expect(result.isValid).toBe(true);
    expect(result.server.url).toBe('https://api.example.com/mcp');
    expect(result.unresolvedFields).toEqual([]);
  });

  it('should resolve auth.token templates', () => {
    const server = createTestServer({
      name: 'test-server',
      transport: 'http',
      url: 'https://api.example.com',
      auth: {
        type: 'bearer',
        token: '{{ user.env.BEARER_TOKEN }}',
      },
    });

    const result = resolveMcpServerTemplates(server, context);

    expect(result.isValid).toBe(true);
    expect(result.server.auth?.token).toBe('bearer_xyz');
  });

  it('should mark server as invalid when required url template fails to resolve', () => {
    const server = createTestServer({
      name: 'broken-server',
      transport: 'http',
      url: '{{ user.env.MISSING_URL }}',
    });

    const result = resolveMcpServerTemplates(server, context);

    expect(result.isValid).toBe(false);
    expect(result.unresolvedFields).toContain('url');
    expect(result.errorMessage).toContain('broken-server');
    expect(result.errorMessage).toContain('unresolved required templates');
  });

  it('should remain valid when optional env templates fail to resolve', () => {
    const server = createTestServer({
      name: 'test-server',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: {
        OPTIONAL_VAR: '{{ user.env.MISSING_VAR }}',
        GITHUB_TOKEN: '{{ user.env.GITHUB_TOKEN }}',
      },
    });

    const result = resolveMcpServerTemplates(server, context);

    // stdio doesn't require url, so missing env vars don't make it invalid
    expect(result.isValid).toBe(true);
    expect(result.unresolvedFields).toContain('env.OPTIONAL_VAR');
    expect(result.server.env).toEqual({
      GITHUB_TOKEN: 'gh_secret123',
    });
  });

  it('should pass through non-templated values unchanged', () => {
    const server = createTestServer({
      name: 'static-server',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: {
        STATIC_VAR: 'static_value',
      },
    });

    const result = resolveMcpServerTemplates(server, context);

    expect(result.isValid).toBe(true);
    expect(result.server.env).toEqual({
      STATIC_VAR: 'static_value',
    });
    expect(result.unresolvedFields).toEqual([]);
  });

  it('should handle SSE transport with missing url', () => {
    const server = createTestServer({
      name: 'sse-server',
      transport: 'sse',
      url: '{{ user.env.MISSING }}',
    });

    const result = resolveMcpServerTemplates(server, context);

    expect(result.isValid).toBe(false);
    expect(result.errorMessage).toContain('sse-server');
  });
});

describe('buildMCPTemplateContext (with session.custom_context)', () => {
  const env = {
    AGOR_USER_ENV_KEYS: 'GITHUB_TOKEN',
    GITHUB_TOKEN: 'gh_secret123',
  };

  it('exposes session.custom_context.* when provided', () => {
    const ctx = buildMCPTemplateContext({
      env,
      sessionCustomContext: {
        upstream_jwt: 'eyJhbGciOi.payload.sig',
        workspace_id: 'ws-42',
      },
    });

    expect(ctx.user.env.GITHUB_TOKEN).toBe('gh_secret123');
    expect(ctx.session?.custom_context.upstream_jwt).toBe('eyJhbGciOi.payload.sig');
    expect(ctx.session?.custom_context.workspace_id).toBe('ws-42');
  });

  it('omits the session namespace when custom_context is null/undefined', () => {
    const ctxNull = buildMCPTemplateContext({ env, sessionCustomContext: null });
    expect(ctxNull.session).toBeUndefined();

    const ctxUndef = buildMCPTemplateContext({ env });
    expect(ctxUndef.session).toBeUndefined();
  });

  it('omits the session namespace when custom_context is an array (defensive)', () => {
    // Array-typed payloads aren't a valid custom_context shape (the field
    // is Record<string, unknown>); guard against them rather than letting
    // numeric indices accidentally appear as template paths.
    const ctx = buildMCPTemplateContext({
      env,
      sessionCustomContext: ['malformed'] as unknown as Record<string, unknown>,
    });
    expect(ctx.session).toBeUndefined();
  });

  it('still applies the AGOR_USER_ENV_KEYS allowlist for user.env.*', () => {
    const ctx = buildMCPTemplateContext({
      env: {
        AGOR_USER_ENV_KEYS: 'GITHUB_TOKEN',
        GITHUB_TOKEN: 'gh_secret123',
        AGOR_MASTER_SECRET: 'should_not_be_exposed',
      },
      sessionCustomContext: { upstream_jwt: 'jwt' },
    });
    expect(ctx.user.env.AGOR_MASTER_SECRET).toBeUndefined();
    expect(ctx.user.env.GITHUB_TOKEN).toBe('gh_secret123');
  });
});

describe('resolveMcpServerTemplates with session.custom_context', () => {
  const context = {
    user: { env: { GITHUB_TOKEN: 'gh_secret123' } },
    session: {
      custom_context: {
        upstream_jwt: 'eyJhbGciOi.payload.sig',
        nested: { inner: 'deep_value' },
      },
    },
  };

  it('resolves {{session.custom_context.<key>}} into auth.token', () => {
    const server = createTestServer({
      name: 'external-mcp',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      auth: {
        type: 'bearer',
        token: '{{ session.custom_context.upstream_jwt }}',
      },
    });

    const result = resolveMcpServerTemplates(server, context);

    expect(result.isValid).toBe(true);
    expect(result.server.auth?.token).toBe('eyJhbGciOi.payload.sig');
    expect(result.unresolvedFields).toEqual([]);
  });

  it('treats a missing session-context key as an unresolved template, same as user.env.*', () => {
    const server = createTestServer({
      name: 'external-mcp',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      auth: {
        type: 'bearer',
        token: '{{ session.custom_context.refresh_token }}',
      },
    });

    const result = resolveMcpServerTemplates(server, context);

    // Missing optional auth field doesn't invalidate the server (only url does),
    // but the unresolved-fields list must surface the problem for operators.
    expect(result.unresolvedFields).toContain('auth.token');
  });

  it('lets one server mix user.env and session.custom_context in different fields', () => {
    const server = createTestServer({
      name: 'mixed-server',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      auth: {
        type: 'jwt',
        api_url: 'https://auth.example.com/api/v1/auth/',
        api_token: '{{ user.env.GITHUB_TOKEN }}', // contrived but representative
        api_secret: '{{ session.custom_context.upstream_jwt }}',
      },
    });

    const result = resolveMcpServerTemplates(server, context);

    expect(result.isValid).toBe(true);
    expect(result.server.auth?.api_token).toBe('gh_secret123');
    expect(result.server.auth?.api_secret).toBe('eyJhbGciOi.payload.sig');
  });

  it('resolves nested handlebars paths inside custom_context', () => {
    const server = createTestServer({
      name: 'nested-server',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      auth: {
        type: 'bearer',
        token: '{{ session.custom_context.nested.inner }}',
      },
    });

    const result = resolveMcpServerTemplates(server, context);
    expect(result.isValid).toBe(true);
    expect(result.server.auth?.token).toBe('deep_value');
  });
});
