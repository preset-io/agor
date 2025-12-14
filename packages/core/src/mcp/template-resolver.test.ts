import { describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { MCPServer, MCPServerID } from '../types';
import {
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
