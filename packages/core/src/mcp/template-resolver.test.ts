import { describe, expect, it, vi } from 'vitest';
import { generateId } from '../lib/ids';
import type { MCPServer, MCPServerID } from '../types';
import { isValidMCPHttpUrlTemplate } from './template-patterns';
import {
  buildMCPTemplateContextFromEnv,
  extractMCPTemplateDependencies,
  isUserEnvPlaceholder,
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

describe('isUserEnvPlaceholder', () => {
  it('accepts a bare user.env placeholder, tolerating whitespace', () => {
    expect(isUserEnvPlaceholder('{{ user.env.GARMIN_TOKEN }}')).toBe(true);
    expect(isUserEnvPlaceholder('{{user.env.X}}')).toBe(true);
    expect(isUserEnvPlaceholder('  {{ user.env.API_TOKEN }}  ')).toBe(true);
  });

  it('rejects non-user.env templates, helper/fallback expressions, and brace-bearing secrets', () => {
    expect(isUserEnvPlaceholder('{{secret}}')).toBe(false);
    expect(isUserEnvPlaceholder('{{ env.X }}')).toBe(false);
    expect(isUserEnvPlaceholder('{{default user.env.MISSING "sk-live-abc"}}')).toBe(false);
    expect(isUserEnvPlaceholder('{{ lookup user.env "SECRET" }}')).toBe(false);
    expect(isUserEnvPlaceholder('sk-live-{{user.env.X}}-tail')).toBe(false);
    expect(isUserEnvPlaceholder('{{user.env.A}}{{user.env.B}}')).toBe(false);
    expect(isUserEnvPlaceholder('{{ outer {{ user.env.X }} }}')).toBe(false);
    expect(isUserEnvPlaceholder('plain-secret')).toBe(false);
  });
});

describe('isValidMCPHttpUrlTemplate', () => {
  it('accepts supported user URL templates and rejects arbitrary expressions or protocols', () => {
    expect(isValidMCPHttpUrlTemplate('{{ user.env.MCP_URL }}/mcp')).toBe(true);
    expect(isValidMCPHttpUrlTemplate('https://{{ user.env.TENANT }}.example.test/mcp')).toBe(true);
    expect(isValidMCPHttpUrlTemplate('https://example.test/{{user.env.PATH}}')).toBe(true);
    expect(isValidMCPHttpUrlTemplate('{{ lookup user.env "MCP_URL" }}')).toBe(false);
    expect(isValidMCPHttpUrlTemplate('file://{{ user.env.PATH }}')).toBe(false);
    expect(isValidMCPHttpUrlTemplate('https://{{ user.env.BROKEN }')).toBe(false);
  });
});

describe('extractMCPTemplateDependencies', () => {
  it('binds every absolute dependency in supported default/helper/nested expressions', () => {
    const result = extractMCPTemplateDependencies(
      createTestServer({
        transport: 'http',
        url: 'https://example.test/{{uppercase (default user.env.PRIMARY user.env.FALLBACK)}}',
        headers: { 'X-Tenant': '{{replace user.env.TENANT "-" "_"}}' },
      })
    );
    expect(result.valid).toBe(true);
    expect([...result.keys].sort()).toEqual(['FALLBACK', 'PRIMARY', 'TENANT']);
  });

  it.each([
    '{{@root.user.env.SECRET}}',
    '{{this.user.env.SECRET}}',
    '{{./user.env.SECRET}}',
    '{{lookup user.env "SECRET"}}',
    '{{lookup (lookup user "env") user.env.KEY}}',
    '{{#with user}}{{env.SECRET}}{{/with}}',
    '{{unknownHelper user.env.SECRET}}',
  ])('rejects indeterminate gateway grammar: %s', (template) => {
    expect(
      extractMCPTemplateDependencies(
        createTestServer({ transport: 'http', url: `https://example.test/${template}` })
      )
    ).toMatchObject({ valid: false, mightReferenceUserEnv: true });
  });
});

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

  it('should resolve custom HTTP header templates', () => {
    const server = createTestServer({
      name: 'datadog',
      transport: 'http',
      url: 'https://mcp.example.com',
      headers: {
        'DD-API-KEY': '{{ user.env.BEARER_TOKEN }}',
        'X-Static': 'static',
      },
    });

    const result = resolveMcpServerTemplates(server, context);

    expect(result.isValid).toBe(true);
    expect(result.server.headers).toEqual({
      'DD-API-KEY': 'bearer_xyz',
      'X-Static': 'static',
    });
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
    expect(result.errorMessage).not.toContain('broken-server');
    expect(result.errorMessage).toContain('invalid or unresolved url');
  });

  it('never exposes malformed secret-bearing URL/header/env/auth templates in logs or errors', () => {
    const sentinel = 'SENTINEL_MCP_TEMPLATE_SECRET_f31ba6';
    const malformed = `${sentinel}{{#if user.env.MISSING_SECRET}}`;
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
    try {
      const result = resolveMcpServerTemplates(
        createTestServer({
          name: 'secret-safe-template-test',
          transport: 'http',
          url: `https://mcp.example.test/${malformed}`,
          headers: { Authorization: malformed },
          env: { MCP_PRIVATE_VALUE: malformed },
          auth: {
            type: 'jwt',
            api_url: `https://auth.example.test/${malformed}`,
            api_token: malformed,
            api_secret: malformed,
          },
        }),
        context
      );

      expect(result.isValid).toBe(false);
      expect(result.unresolvedFields).toEqual(
        expect.arrayContaining(['url', 'headers.*', 'env.*', 'auth.api_token', 'auth.api_secret'])
      );
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(sentinel);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  const markerFamilyCases = [
    {
      family: 'url',
      build: (value: string) =>
        createTestServer({ transport: 'http', url: `https://mcp.example.test/${value}` }),
    },
    {
      family: 'headers',
      build: (value: string) =>
        createTestServer({
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: { 'X-Private': value },
        }),
    },
    {
      family: 'env',
      build: (value: string) =>
        createTestServer({ transport: 'stdio', command: 'node', env: { PRIVATE: value } }),
    },
    {
      family: 'bearer',
      build: (value: string) =>
        createTestServer({
          transport: 'http',
          url: 'https://mcp.example.test',
          auth: { type: 'bearer', token: value },
        }),
    },
    {
      family: 'jwt',
      build: (value: string) =>
        createTestServer({
          transport: 'http',
          url: 'https://mcp.example.test',
          auth: {
            type: 'jwt',
            api_url: 'https://auth.example.test/token',
            api_token: 'configured',
            api_secret: value,
          },
        }),
    },
    {
      family: 'oauth',
      build: (value: string) =>
        createTestServer({
          transport: 'http',
          url: 'https://mcp.example.test',
          auth: { type: 'oauth', oauth_client_secret: value },
        }),
    },
  ] as const;

  it.each(
    markerFamilyCases.flatMap(({ family, build }) =>
      (
        [
          ['unmatched opening marker', 'SENTINEL_DIRECT_OPEN_{{'],
          ['unmatched closing marker', 'SENTINEL_DIRECT_CLOSE_}}'],
        ] as const
      ).map(([kind, value]) => ({ family, kind, value, build }))
    )
  )('rejects a directly stored $kind in $family without disclosure', ({ value, build }) => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
    try {
      const result = resolveMcpServerTemplates(build(value), context);
      expect(result.isValid).toBe(false);
      expect(JSON.stringify(result)).not.toContain(value);
      expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(value);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it.each(
    markerFamilyCases.flatMap(({ family, build }) =>
      (
        [
          ['unmatched opening marker', 'SENTINEL_ENV_OPEN_{{'],
          ['unmatched closing marker', 'SENTINEL_ENV_CLOSE_}}'],
        ] as const
      ).map(([kind, value]) => ({ family, kind, value, build }))
    )
  )('rejects a $kind introduced through user.env in $family', ({ value, build }) => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
    try {
      const result = resolveMcpServerTemplates(build('{{ user.env.INJECTED }}'), {
        user: { env: { INJECTED: value } },
      });
      expect(result.isValid).toBe(false);
      expect(JSON.stringify(result)).not.toContain(value);
      expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(value);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
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
    expect(result.unresolvedFields).toContain('env.*');
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
    expect(result.errorMessage).not.toContain('sse-server');
    expect(result.errorMessage).toContain('invalid or unresolved url');
  });

  it.each([
    ['file protocol', 'file:///tmp/mcp'],
    ['malformed value', 'not a URL'],
    ['leftover template', 'https://{{still.secret}}/mcp'],
    ['embedded credentials', 'https://user:password@example.test/mcp'],
  ])('rejects a resolved URL with %s without echoing it', (_label, resolvedUrl) => {
    const secret = 'password';
    const result = resolveMcpServerTemplates(
      createTestServer({ transport: 'http', url: resolvedUrl }),
      context
    );

    expect(result.isValid).toBe(false);
    expect(result.errorMessage).not.toContain(secret);
    expect(result.errorMessage).not.toContain(resolvedUrl);
  });

  it('rejects a user-env URL that resolves to embedded credentials without logging the secret', () => {
    const secretUrl = 'https://user:super-secret@example.test/mcp';
    const result = resolveMcpServerTemplates(
      createTestServer({ transport: 'http', url: '{{ user.env.MCP_URL }}' }),
      { user: { env: { MCP_URL: secretUrl } } }
    );

    expect(result.isValid).toBe(false);
    expect(result.errorMessage).not.toContain(secretUrl);
    expect(result.errorMessage).not.toContain('super-secret');
  });
});
