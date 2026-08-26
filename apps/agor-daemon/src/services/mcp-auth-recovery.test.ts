import { asMCPExternalError } from '@agor/core/mcp';
import { OAuthConfigurationError, OAuthDCRFailure } from '@agor/core/tools/mcp/oauth-mcp-transport';
import { describe, expect, it, vi } from 'vitest';
import { classifyMCPAuthRecovery, recoveryForOAuthAttemptFailure } from './mcp-auth-recovery';

describe('MCP auth recovery contract', () => {
  it('maps DCR diagnostics to actionable public state without provider text', () => {
    const recovery = classifyMCPAuthRecovery(
      new OAuthDCRFailure('provider leaked secret=abc', {
        stage: 'dcr_registration',
        http_status: 500,
      }),
      { mcpServerId: 'server-a', redirectUri: 'https://agor.example/oauth/callback' }
    );
    expect(recovery).toMatchObject({
      category: 'client_registration_failed',
      action: 'configure_client',
      mcp_server_id: 'server-a',
    });
    expect(JSON.stringify(recovery)).not.toContain('secret=abc');
    expect(JSON.stringify(recovery)).not.toContain('dcr_registration');
  });

  it('maps durable failures without exposing internal failure detail', () => {
    expect(recoveryForOAuthAttemptFailure('authorization_denied', 'server-a')).toMatchObject({
      category: 'authorization_denied',
      action: 'reauthenticate',
    });
    const unknown = recoveryForOAuthAttemptFailure('provider_raw_secret', 'server-a');
    expect(unknown).toMatchObject({
      category: 'authentication_required',
      action: 'reauthenticate',
    });
    expect(JSON.stringify(unknown)).not.toContain('provider_raw_secret');
  });

  it('prefers typed OAuth configuration codes and sanitizes unknown fallbacks', () => {
    expect(
      classifyMCPAuthRecovery(
        new OAuthConfigurationError('issuer_mismatch', 'issuer=https://secret.internal')
      )
    ).toMatchObject({ category: 'metadata_incompatible', action: 'review_compatibility' });
    expect(
      classifyMCPAuthRecovery(new OAuthConfigurationError('client_registration_required'))
    ).toMatchObject({ category: 'client_registration_required', action: 'configure_client' });

    const unknown = classifyMCPAuthRecovery(new Error('provider secret=do-not-reflect'));
    expect(unknown).toMatchObject({ category: 'unknown', action: 'retry' });
    expect(JSON.stringify(unknown)).not.toContain('do-not-reflect');
  });

  it.each([
    ['provider_rejected', 'reauthenticate'],
    ['invalid_response', 'retry'],
    ['configuration_required', 'review_configuration'],
  ] as const)('preserves the shared closed %s recovery contract', (category, action) => {
    const recovery = classifyMCPAuthRecovery(
      asMCPExternalError(new Error('SENTINEL_PROVIDER_PROSE'), {
        stage: 'oauth',
        category,
      })
    );

    expect(recovery).toMatchObject({ category, action });
    expect(JSON.stringify(recovery)).not.toContain('SENTINEL');
  });

  it('fails closed for hostile proxies without invoking name/code accessors', () => {
    const sentinel = 'SENTINEL_HOSTILE_RECOVERY_PROXY';
    const getter = vi.fn(() => {
      throw new Error(sentinel);
    });
    const getPrototypeOf = vi.fn(() => {
      throw new Error(sentinel);
    });
    const hostile = new Proxy(new OAuthConfigurationError('issuer_mismatch'), {
      getPrototypeOf,
      getOwnPropertyDescriptor(target, property) {
        if (property === 'name' || property === 'code' || property === 'failureCode') {
          return { configurable: true, get: getter };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const recovery = classifyMCPAuthRecovery(hostile);

    expect(recovery).toMatchObject({ category: 'unknown', action: 'retry' });
    expect(JSON.stringify(recovery)).not.toContain(sentinel);
    expect(getter).not.toHaveBeenCalled();
    expect(getPrototypeOf).toHaveBeenCalled();
  });
});
