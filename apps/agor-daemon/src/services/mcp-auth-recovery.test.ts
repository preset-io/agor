import { Conflict, Forbidden } from '@agor/core/feathers';
import { asMCPExternalError } from '@agor/core/mcp';
import { OAuthConfigurationError, OAuthDCRFailure } from '@agor/core/tools/mcp/oauth-mcp-transport';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyMCPAuthRecovery,
  MCPLinkAdmissionError,
  recoveryForOAuthAttemptFailure,
} from './mcp-auth-recovery';
import { MCPClientCredentialsConfigurationError, MCPOAuthRefreshBusyError } from './mcp-oauth-use';

describe('MCP auth recovery contract', () => {
  it('distinguishes transient rotation and machine configuration from browser reauth', () => {
    expect(classifyMCPAuthRecovery(new MCPOAuthRefreshBusyError())).toMatchObject({
      action: 'retry',
    });
    expect(classifyMCPAuthRecovery(new MCPClientCredentialsConfigurationError())).toMatchObject({
      category: 'configuration_required',
      action: 'review_configuration',
      message: expect.stringContaining('client-credentials-only'),
    });
  });
  it.each([
    [new Forbidden('SENTINEL_FORBIDDEN'), 'permission_changed', 'retry'],
    [new Conflict('SENTINEL_CONFLICT'), 'configuration_changed', 'save_and_retry'],
  ] as const)(
    'preserves public recovery for trusted control error %#',
    (error, category, action) => {
      const recovery = classifyMCPAuthRecovery(error);

      expect(recovery).toMatchObject({ category, action });
      expect(JSON.stringify(recovery)).not.toContain('SENTINEL');
    }
  );

  it('separates a link that was not admitted from an authority that changed', () => {
    // The redemption lanes throw ONE generic message for every binding that
    // moved, so the classifier is the only place left that can tell "this link
    // is spent" from "your access changed". Reporting the first as the second
    // sends the user to inspect permissions that are fine.
    const refused = classifyMCPAuthRecovery(
      new MCPLinkAdmissionError('This MCP connect action is invalid, expired, or superseded.'),
      { mcpServerId: 'server-a' }
    );

    expect(refused).toMatchObject({
      category: 'link_not_admitted',
      action: 'request_new_link',
      mcp_server_id: 'server-a',
    });
    expect(refused.message).toContain('new link');
    expect(refused.message).not.toContain('authority');

    // And an ordinary `Forbidden` — a real authority change — is untouched,
    // even though the marker is one of its subclasses.
    expect(classifyMCPAuthRecovery(new Forbidden('SENTINEL'))).toMatchObject({
      category: 'permission_changed',
      action: 'retry',
    });
  });

  it('keeps the marker invisible to anything outside this process', () => {
    // The whole point of the lanes' single generic message is that a redeemer
    // learns nothing from a refusal. The distinction is Agor-owned, so it must
    // not ride out on the wire: same status, same name, same serialization.
    const refused = new MCPLinkAdmissionError(
      'This MCP connect action is invalid, expired, or superseded.'
    );
    const plain = new Forbidden('This MCP connect action is invalid, expired, or superseded.');

    expect(refused).toBeInstanceOf(Forbidden);
    expect(JSON.stringify(refused)).toBe(JSON.stringify(plain));
    expect(refused.code).toBe(403);
  });

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
    ['storage_policy_rejected', 'contact_admin'],
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

  it.each([
    [
      new OAuthConfigurationError('client_registration_required', 'SECRET', 'dcr_disabled'),
      'dcr_disabled',
    ],
    [
      new OAuthDCRFailure('SECRET', { stage: 'dcr_endpoint_discovery' }),
      'registration_endpoint_missing',
    ],
    [
      new OAuthConfigurationError('metadata_incompatible', 'SECRET', 'protected_resource_mismatch'),
      'protected_resource_mismatch',
    ],
    [new OAuthConfigurationError('issuer_mismatch', 'SECRET'), 'issuer_mismatch'],
    [new OAuthConfigurationError('pkce_required', 'SECRET'), 'pkce_required'],
    [new OAuthConfigurationError('metadata_incompatible', 'SECRET'), 'profile_rejected'],
    [
      new OAuthConfigurationError('endpoint_override_mismatch', 'SECRET'),
      'endpoint_override_mismatch',
    ],
  ] as const)('returns closed reason and exact policy for %s', (error, reason) => {
    const oauthPolicy = {
      effective_mode: 'strict',
      effective_dcr_mode: 'disabled',
      dcr_mode_source: 'explicit',
    } as const;
    const recovery = classifyMCPAuthRecovery(error, { oauthPolicy });
    expect(recovery).toMatchObject({ failure_reason: reason, oauth_policy: oauthPolicy });
    expect(JSON.stringify(recovery)).not.toContain('SECRET');
    expect(recovery.message).not.toContain('use legacy');
  });

  it('does not infer a reason from provider prose or disclose policy after authority loss', () => {
    const oauthPolicy = {
      effective_mode: 'legacy',
      effective_dcr_mode: 'disabled',
      dcr_mode_source: 'explicit',
    } as const;
    expect(
      classifyMCPAuthRecovery(new Error('issuer_mismatch secret=abc')).failure_reason
    ).toBeUndefined();
    expect(
      classifyMCPAuthRecovery(new Forbidden('private'), { oauthPolicy }).oauth_policy
    ).toBeUndefined();
    expect(
      classifyMCPAuthRecovery(new Conflict('stale'), { oauthPolicy }).oauth_policy
    ).toBeUndefined();
    expect(recoveryForOAuthAttemptFailure('callback_issuer_mismatch')).toMatchObject({
      failure_reason: 'issuer_mismatch',
    });
    expect(recoveryForOAuthAttemptFailure('callback_issuer_missing')).toMatchObject({
      failure_reason: 'profile_rejected',
    });
  });

  it('names an unregistered redirect URI first when authorization never came back', () => {
    const recovery = recoveryForOAuthAttemptFailure('authorization_never_returned', 'server-a');
    expect(recovery).toMatchObject({
      category: 'authentication_required',
      action: 'reauthenticate',
      mcp_server_id: 'server-a',
    });
    // The proxy exists because the provider rejects a mismatched redirect URI
    // front-channel, so Agor never observes it. The guidance has to lead with
    // the cause the user cannot fix by trying again.
    const message = recovery!.message;
    expect(message).toContain('callback URL');
    expect(message.indexOf('callback URL')).toBeLessThan(message.indexOf('closed'));
    expect(message).not.toBe(
      recoveryForOAuthAttemptFailure('authorization_timed_out', 'server-a')!.message
    );
  });

  it('classifies an authorize-time redirect binding refusal as its own reason', () => {
    expect(
      classifyMCPAuthRecovery(
        new OAuthConfigurationError(
          'redirect_uri_mismatch',
          'The OAuth client is registered under a different Agor callback URL.',
          'redirect_uri_mismatch'
        )
      )
    ).toMatchObject({
      category: 'redirect_configuration_required',
      action: 'configure_redirect',
      failure_reason: 'redirect_uri_mismatch',
    });
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
