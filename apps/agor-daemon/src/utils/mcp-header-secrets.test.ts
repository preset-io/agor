import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  redactMCPServerSecrets,
  shouldExposeMCPServerSecrets,
  shouldExposeMCPServerSecretsForSessionToken,
} from './mcp-header-secrets';

const baseServer = {
  mcp_server_id: '00000000-0000-0000-0000-000000000001',
  name: 'remote',
  transport: 'http',
  scope: 'global',
  source: 'user',
  enabled: true,
  created_at: new Date(),
  updated_at: new Date(),
} as MCPServer;

describe('MCP server secret redaction', () => {
  it('redacts custom headers and auth secret material while preserving non-secret metadata', () => {
    const redacted = redactMCPServerSecrets({
      ...baseServer,
      headers: { 'X-Api-Key': 'raw-header' },
      auth: {
        type: 'oauth',
        oauth_authorization_url: 'https://auth.example/authorize',
        oauth_token_url: 'https://auth.example/token',
        oauth_client_id: 'public-client-id',
        oauth_client_secret: 'raw-client-secret',
        oauth_access_token: 'raw-access-token',
        oauth_refresh_token: 'raw-refresh-token',
        oauth_scope: 'read',
        oauth_mode: 'per_user',
        oauth_token_expires_at: 123,
      },
    });

    expect(redacted.headers).toEqual({ 'X-Api-Key': MCP_HEADER_REDACTED_SENTINEL });
    expect(redacted.auth).toMatchObject({
      type: 'oauth',
      oauth_authorization_url: 'https://auth.example/authorize',
      oauth_token_url: 'https://auth.example/token',
      oauth_client_id: 'public-client-id',
      oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
      oauth_access_token: MCP_HEADER_REDACTED_SENTINEL,
      oauth_refresh_token: MCP_HEADER_REDACTED_SENTINEL,
      oauth_scope: 'read',
      oauth_mode: 'per_user',
      oauth_token_expires_at: 123,
    });
  });

  it('does not expose secrets to normal provider users, including admins', () => {
    expect(
      shouldExposeMCPServerSecrets({ provider: 'rest', user: { role: 'admin' } } as never)
    ).toBe(false);
  });

  it('does not accept the removed legacy session-token strategy as authority', () => {
    const legacyParams = {
      provider: 'socketio',
      authentication: { strategy: 'session-token' },
      session_id: 'session-a',
    } as never;

    expect(
      shouldExposeMCPServerSecrets(legacyParams, {
        allowSessionToken: true,
        sessionId: 'session-a',
      })
    ).toBe(false);
  });

  it('exposes executor-session JWT secrets only when scoped to the same session', () => {
    const executorParams = {
      provider: 'socketio',
      authentication: {
        strategy: 'jwt',
        payload: {
          type: 'executor-session',
          purpose: 'executor-task',
          session_id: 'session-a',
          task_id: 'task-a',
        },
      },
      session_id: 'session-a',
    } as never;

    expect(
      shouldExposeMCPServerSecrets(executorParams, {
        allowSessionToken: true,
        sessionId: 'session-a',
      })
    ).toBe(true);
    expect(
      shouldExposeMCPServerSecretsForSessionToken(executorParams, { sessionId: 'session-a' })
    ).toBe(true);

    expect(
      shouldExposeMCPServerSecrets(executorParams, {
        allowSessionToken: true,
        sessionId: 'session-b',
      })
    ).toBe(false);

    expect(
      shouldExposeMCPServerSecrets(
        { ...executorParams, session_id: 'caller-supplied-other-session' } as never,
        { allowSessionToken: true, sessionId: 'session-a' }
      )
    ).toBe(false);
  });

  it('does not expose secrets to taskless executor command credentials', () => {
    expect(
      shouldExposeMCPServerSecretsForSessionToken(
        {
          provider: 'socketio',
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-command',
              session_id: 'branch-clean',
              branch_id: 'branch-a',
            },
          },
        } as never,
        { sessionId: 'branch-clean' }
      )
    ).toBe(false);
  });

  it('rejects a raw bearer when verified payload metadata is absent', () => {
    const params = {
      provider: 'socketio',
      authentication: {
        strategy: 'jwt',
        accessToken: 'caller-bearer',
      },
    } as never;

    expect(
      shouldExposeMCPServerSecrets(params, {
        allowSessionToken: true,
        sessionId: 'session-a',
      })
    ).toBe(false);
  });

  it('does not expose executor-session JWT secrets without explicit route opt-in', () => {
    expect(
      shouldExposeMCPServerSecrets({
        provider: 'socketio',
        authentication: {
          strategy: 'jwt',
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            session_id: 'session-a',
          },
        },
        session_id: 'session-a',
      } as never)
    ).toBe(false);
  });

  it('does not treat internal or service callers as session-token scoped callers', () => {
    expect(shouldExposeMCPServerSecrets({} as never)).toBe(true);
    expect(shouldExposeMCPServerSecretsForSessionToken({} as never)).toBe(false);
    expect(
      shouldExposeMCPServerSecretsForSessionToken({
        provider: 'rest',
        user: { _isServiceAccount: true },
      } as never)
    ).toBe(false);
  });
});
