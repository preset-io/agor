import type { MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { scrubMCPSecretsFromExecutorEnv } from './executor-env.js';

describe('mediated MCP executor environment scrub', () => {
  it('removes every referenced/literal credential source without low-entropy collisions', () => {
    const env = {
      MCP_KEY: 'referenced-secret-value',
      DUPLICATE: 'literal-bearer-secret',
      JWT_CLIENT: 'jwt-client-secret',
      RAW_HEADER_SECRET: 'literal-header-secret',
      DEBUG: '1',
      NODE_ENV: 'test',
      AGOR_USER_ENV_KEYS: 'MCP_KEY,DEBUG,NODE_ENV',
    };
    scrubMCPSecretsFromExecutorEnv(env, [
      {
        transport: 'http',
        url: 'https://provider.example/{{ user.env.MCP_KEY }}',
        headers: {
          'X-Secret': 'literal-bearer-secret',
          Authorization: 'Bearer literal-header-secret',
        },
        auth: { type: 'jwt', api_token: 'jwt-client-name', api_secret: 'jwt-client-secret' },
      } as MCPServer,
    ]);

    expect(env).toEqual({ DEBUG: '1', NODE_ENV: 'test', AGOR_USER_ENV_KEYS: 'DEBUG,NODE_ENV' });
  });

  it('scrubs stdio secret environments even though stdio is excluded before spawn', () => {
    const env = { STDIO_SECRET: 'secret-bearing-stdio-value', SAFE: 'available' };
    scrubMCPSecretsFromExecutorEnv(env, [
      {
        transport: 'stdio',
        env: { SECRET: '{{ user.env.STDIO_SECRET }}' },
      } as MCPServer,
    ]);
    expect(env).toEqual({ SAFE: 'available' });
  });

  it('binds default, helper, nested, and fallback user.env expressions', () => {
    const env = {
      PRIMARY: 'primary-secret',
      FALLBACK: 'fallback-secret',
      NESTED: 'nested-secret',
      SAFE: 'kept',
    };
    scrubMCPSecretsFromExecutorEnv(env, [
      {
        transport: 'http',
        url: 'https://provider.example/{{default user.env.PRIMARY user.env.FALLBACK}}',
        headers: { 'X-Nested': '{{uppercase (default user.env.NESTED user.env.FALLBACK)}}' },
      } as MCPServer,
    ]);
    expect(env).toEqual({ SAFE: 'kept' });
  });

  it.each([
    '{{@root.user.env.SECRET}}',
    '{{this.user.env.SECRET}}',
    '{{./user.env.SECRET}}',
    '{{lookup user.env user.env.KEY_NAME}}',
    '{{lookup (lookup user "env") "SECRET"}}',
    '{{#with user}}{{env.SECRET}}{{/with}}',
  ])('excludes indeterminate template %s and scrubs every user env key', (template) => {
    const env = {
      KEY_NAME: 'SECRET',
      SECRET: 'never-export',
      SECOND: 'also-never-export',
      SAFE: 'kept',
      AGOR_USER_ENV_KEYS: 'KEY_NAME,SECRET,SECOND',
    };
    scrubMCPSecretsFromExecutorEnv(env, [
      {
        transport: 'http',
        url: `https://provider.example/${template}`,
      } as MCPServer,
    ]);
    expect(env).toEqual({ SAFE: 'kept' });
  });
});
