import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MCP_OAUTH_RELAY } from '../../types/mcp-oauth-relay';
import { completeMCPOAuthFlow, startMCPOAuthFlow } from './oauth-mcp-transport';
import { refreshMCPToken } from './oauth-refresh';

/** Disposable public/confidential providers shared by wire and Chromium tests. */
export async function runStableCallbackFixture(
  confidential: boolean,
  authorize: (url: string) => Promise<string> = async (url) => {
    const response = await fetch(url, { redirect: 'manual' });
    return response.headers.get('location')!;
  }
): Promise<void> {
  let origin = '';
  const clientId = 'customer-app';
  const clientSecret = confidential ? 'test-customer-secret' : undefined;
  let callback = ''; // Disposable relay stub; never a real Cloud/provider destination.
  const codes = new Map<string, string>();
  const redirects: string[] = [];
  let registrations = 0;
  let exchanges = 0;
  const failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname.startsWith(MCP_OAUTH_RELAY.callbackPrefix)) {
        res.setHeader('Content-Type', 'text/html');
        res.end('<p>Callback received</p>');
      } else if (url.pathname === '/resource') {
        res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
      } else if (url.pathname === '/.well-known/oauth-authorization-server') {
        res.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            code_challenge_methods_supported: ['S256'],
            response_types_supported: ['code'],
            authorization_response_iss_parameter_supported: !confidential,
          })
        );
      } else if (url.pathname === '/register') {
        registrations++;
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        assert.deepEqual(body.redirect_uris, [callback]);
        redirects.push(body.redirect_uris[0]);
        res.end(
          JSON.stringify({
            client_id: clientId,
            redirect_uris: [callback],
            token_endpoint_auth_method: 'none',
          })
        );
      } else if (url.pathname === '/authorize') {
        assert.equal(url.searchParams.get('redirect_uri'), callback);
        assert.equal(url.searchParams.get('resource'), `${origin}/mcp`);
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        redirects.push(url.searchParams.get('redirect_uri')!);
        const code = randomUUID();
        codes.set(code, url.searchParams.get('code_challenge')!);
        const target = new URL(callback);
        target.searchParams.set('code', code);
        target.searchParams.set('state', url.searchParams.get('state')!);
        if (!confidential) target.searchParams.set('iss', origin);
        res.writeHead(302, { Location: target.toString() });
        res.end();
      } else if (url.pathname === '/token') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = new URLSearchParams(raw);
        assert.equal(body.get('redirect_uri'), callback);
        assert.equal(body.get('resource'), `${origin}/mcp`);
        redirects.push(body.get('redirect_uri')!);
        if (confidential)
          assert.equal(
            req.headers.authorization,
            `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
          );
        else assert.equal(body.get('client_id'), clientId);
        if (body.get('grant_type') === 'authorization_code') {
          exchanges++;
          const challenge = codes.get(body.get('code')!);
          assert.ok(challenge);
          assert.equal(
            createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),
            challenge
          );
          codes.delete(body.get('code')!);
        } else assert.equal(body.get('refresh_token'), 'fake-refresh');
        res.end(
          JSON.stringify({
            access_token: 'fake-access',
            refresh_token: 'fake-refresh',
            token_type: 'Bearer',
            expires_in: 60,
          })
        );
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    } catch (error) {
      failures.push(error);
      res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  callback = `${origin}${MCP_OAUTH_RELAY.callbackPrefix}${createHash('sha256').update(origin).digest('hex')}`;
  try {
    const context = await startMCPOAuthFlow(
      '',
      confidential ? clientId : undefined,
      'https://old-cell.example.test/callback',
      {
        resourceUri: `${origin}/mcp`,
        resourceMetadataUrl: `${origin}/resource`,
        clientSecret,
        allowLocalhostHttp: true,
        dcrMode: confidential ? 'disabled' : 'advertised',
        compatibilityMode: confidential ? 'marketplace' : 'strict',
        reuseDynamicClientRegistration: false,
        resolveRedirectUri: (issuer) => {
          assert.equal(issuer, origin);
          return callback;
        },
      }
    );
    assert.equal(context.redirectUri, callback);
    const response = new URL(await authorize(context.authorizationUrl));
    await assert.rejects(
      completeMCPOAuthFlow(context, response.searchParams.get('code')!, context.state, {
        cacheToken: false,
        issuer: 'https://wrong-issuer.test',
      })
    );
    assert.equal(exchanges, 0);
    const token = await completeMCPOAuthFlow(
      context,
      response.searchParams.get('code')!,
      response.searchParams.get('state')!,
      { cacheToken: false, issuer: response.searchParams.get('iss') ?? undefined }
    );
    await refreshMCPToken({
      tokenEndpoint: context.tokenEndpoint,
      refreshToken: token.refresh_token!,
      clientId,
      clientSecret,
      resourceUri: context.resourceUri,
      redirectUri: context.redirectUri,
      allowLocalhostHttp: true,
    });
    assert.equal(registrations, confidential ? 0 : 1);
    assert.equal(exchanges, 1);
    assert.deepEqual(new Set(redirects), new Set([callback]));
    assert.deepEqual(failures, []);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
