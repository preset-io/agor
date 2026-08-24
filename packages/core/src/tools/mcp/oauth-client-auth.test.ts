/**
 * Token-endpoint client authentication selection (RFC 6749 §2.3.1, RFC 8414 §2).
 */

import { describe, expect, it } from 'vitest';
import { applyClientAuthentication, selectTokenEndpointAuthMethod } from './oauth-client-auth';

describe('selectTokenEndpointAuthMethod', () => {
  it('defaults to client_secret_basic when metadata omits the field (RFC 8414 §2)', () => {
    expect(selectTokenEndpointAuthMethod({ hasClientSecret: true })).toBe('client_secret_basic');
    expect(
      selectTokenEndpointAuthMethod({ hasClientSecret: true, supportedMethods: undefined })
    ).toBe('client_secret_basic');
    expect(selectTokenEndpointAuthMethod({ hasClientSecret: true, supportedMethods: [] })).toBe(
      'client_secret_basic'
    );
  });

  it('selects client_secret_post when that is all the server advertises (HubSpot)', () => {
    expect(
      selectTokenEndpointAuthMethod({
        hasClientSecret: true,
        supportedMethods: ['client_secret_post'],
      })
    ).toBe('client_secret_post');
  });

  it('prefers client_secret_basic when the server advertises both', () => {
    expect(
      selectTokenEndpointAuthMethod({
        hasClientSecret: true,
        supportedMethods: ['client_secret_post', 'client_secret_basic'],
      })
    ).toBe('client_secret_basic');
  });

  it('uses none for public clients regardless of what the server advertises', () => {
    expect(selectTokenEndpointAuthMethod({ hasClientSecret: false })).toBe('none');
    expect(
      selectTokenEndpointAuthMethod({
        hasClientSecret: false,
        supportedMethods: ['client_secret_post', 'client_secret_basic'],
      })
    ).toBe('none');
  });

  it('honours a registered per-client method over the server-wide list (RFC 7591 §2)', () => {
    expect(
      selectTokenEndpointAuthMethod({
        hasClientSecret: true,
        supportedMethods: ['client_secret_post', 'client_secret_basic'],
        registeredMethod: 'client_secret_post',
      })
    ).toBe('client_secret_post');
  });

  it('ignores an unknown or none registered method and falls back to the server list', () => {
    expect(
      selectTokenEndpointAuthMethod({
        hasClientSecret: true,
        supportedMethods: ['client_secret_post'],
        registeredMethod: 'private_key_jwt',
      })
    ).toBe('client_secret_post');
    // A registered 'none' cannot be honoured verbatim once a secret exists —
    // the server-wide list decides how to present it.
    expect(
      selectTokenEndpointAuthMethod({
        hasClientSecret: true,
        supportedMethods: ['client_secret_post'],
        registeredMethod: 'none',
      })
    ).toBe('client_secret_post');
  });

  it('withholds the secret when the server only accepts unauthenticated clients', () => {
    expect(
      selectTokenEndpointAuthMethod({ hasClientSecret: true, supportedMethods: ['none'] })
    ).toBe('none');
  });

  it('falls back to the RFC default when every advertised method is unsupported', () => {
    expect(
      selectTokenEndpointAuthMethod({
        hasClientSecret: true,
        supportedMethods: ['private_key_jwt', 'tls_client_auth'],
      })
    ).toBe('client_secret_basic');
  });
});

describe('applyClientAuthentication', () => {
  it('client_secret_basic sends the Authorization header and no body credentials', () => {
    const headers: Record<string, string> = {};
    const body: Record<string, string> = {};
    applyClientAuthentication({
      method: 'client_secret_basic',
      clientId: 'cid',
      clientSecret: 'csec',
      headers,
      body,
    });

    expect(headers.Authorization).toBe(`Basic ${Buffer.from('cid:csec').toString('base64')}`);
    expect(body.client_id).toBeUndefined();
    expect(body.client_secret).toBeUndefined();
  });

  it('client_secret_post sends body credentials and no Authorization header', () => {
    const headers: Record<string, string> = {};
    const body: Record<string, string> = {};
    applyClientAuthentication({
      method: 'client_secret_post',
      clientId: 'cid',
      clientSecret: 'csec',
      headers,
      body,
    });

    // RFC 6749 §2.3: exactly one client authentication method per request.
    expect(headers.Authorization).toBeUndefined();
    expect(body.client_id).toBe('cid');
    expect(body.client_secret).toBe('csec');
  });

  it('none sends only client_id, never the secret', () => {
    const headers: Record<string, string> = {};
    const body: Record<string, string> = {};
    applyClientAuthentication({
      method: 'none',
      clientId: 'cid',
      clientSecret: 'csec',
      headers,
      body,
    });

    expect(headers.Authorization).toBeUndefined();
    expect(body.client_id).toBe('cid');
    expect(body.client_secret).toBeUndefined();
  });

  it('client_secret_basic without a secret degrades to body client_id', () => {
    const headers: Record<string, string> = {};
    const body: Record<string, string> = {};
    applyClientAuthentication({
      method: 'client_secret_basic',
      clientId: 'cid',
      headers,
      body,
    });

    expect(headers.Authorization).toBeUndefined();
    expect(body.client_id).toBe('cid');
    expect(body.client_secret).toBeUndefined();
  });
});
