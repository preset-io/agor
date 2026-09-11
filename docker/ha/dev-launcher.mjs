#!/usr/bin/env node

/**
 * Compose-only external-launch issuer for the HA development environment.
 *
 * This is deliberately an identity picker, not an authentication system. It
 * lets a developer impersonate one of a few fixed tenant/user personas while
 * still exercising Agor's real external-launch exchange, signed tenant claim,
 * runtime JWT, PostgreSQL RLS, and Socket.IO channel setup.
 *
 * It is mounted only into docker-compose.ha.yml and is never copied into an
 * Agor daemon/product image.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const HA_DEV_PERSONAS = Object.freeze([
  Object.freeze({
    id: 'acme-alice',
    tenantId: 'acme',
    tenantName: 'Acme',
    subject: 'alice-admin',
    email: 'alice@acme.example.test',
    name: 'Alice Admin',
    role: 'admin',
  }),
  Object.freeze({
    id: 'acme-aaron',
    tenantId: 'acme',
    tenantName: 'Acme',
    subject: 'aaron-member',
    email: 'aaron@acme.example.test',
    name: 'Aaron Member',
    role: 'member',
  }),
  Object.freeze({
    id: 'acme-claude-ha',
    tenantId: 'acme',
    tenantName: 'Acme',
    subject: 'claude-ha-probe',
    email: 'claude-ha-probe@acme.example.test',
    name: 'Claude HA Probe',
    role: 'member',
  }),
  Object.freeze({
    id: 'globex-beatrice',
    tenantId: 'globex',
    tenantName: 'Globex',
    subject: 'beatrice-admin',
    email: 'beatrice@globex.example.test',
    name: 'Beatrice Admin',
    role: 'admin',
  }),
  Object.freeze({
    id: 'globex-ben',
    tenantId: 'globex',
    tenantName: 'Globex',
    subject: 'ben-member',
    email: 'ben@globex.example.test',
    name: 'Ben Member',
    role: 'member',
  }),
]);

const PERSONAS_BY_ID = new Map(HA_DEV_PERSONAS.map((persona) => [persona.id, persona]));
const DEFAULT_CODE_TTL_MS = 60_000;
const DEFAULT_ASSERTION_TTL_SECONDS = 120;
const DEFAULT_MAX_PENDING_CODES = 256;
const MAX_REQUEST_BYTES = 16 * 1024;

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function signHs256(payload, secret) {
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const body = base64UrlJson(payload);
  const input = `${header}.${body}`;
  const signature = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

export function decodeJwtPayload(token) {
  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('Invalid JWT');
  return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
}

function safeReturnTo(raw) {
  if (typeof raw !== 'string') return '/ui/';
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/ui/';
  return value;
}

export function buildLaunchRedirect(publicOrigin, returnTo, launchCode) {
  const origin = new URL(publicOrigin);
  const destination = new URL(safeReturnTo(returnTo), origin);
  if (destination.origin !== origin.origin) throw new Error('Invalid launch return origin');
  destination.searchParams.set('launch_code', launchCode);
  return destination.toString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderPicker(publicOrigin, returnTo) {
  const tenants = [...new Map(HA_DEV_PERSONAS.map((persona) => [persona.tenantId, persona]))];
  const personaJson = JSON.stringify(HA_DEV_PERSONAS).replaceAll('<', '\\u003c');
  const tenantOptions = tenants
    .map(
      ([tenantId, persona]) =>
        `<option value="${escapeHtml(tenantId)}">${escapeHtml(persona.tenantName)}</option>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agor HA Development Login</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d12; color: #f3f5f7; }
    main { width: min(440px, calc(100vw - 32px)); padding: 28px; border: 1px solid #2a3040; border-radius: 16px; background: #151922; box-shadow: 0 24px 70px #0008; }
    h1 { margin: 0 0 8px; font-size: 23px; }
    p { margin: 0 0 24px; color: #aeb6c7; line-height: 1.45; }
    label { display: grid; gap: 8px; margin: 16px 0; font-weight: 600; }
    select, button { width: 100%; border-radius: 9px; border: 1px solid #394157; padding: 11px 12px; font: inherit; }
    select { color: #f3f5f7; background: #0f131b; }
    button { margin-top: 12px; border-color: #7c5cff; background: #7c5cff; color: white; font-weight: 700; cursor: pointer; }
    button:hover { background: #8b70ff; }
    aside { margin-top: 18px; padding-top: 16px; border-top: 1px solid #2a3040; color: #8791a5; font-size: 12px; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <h1>HA development login</h1>
    <p>Choose a disposable tenant identity. This picker intentionally provides no authentication.</p>
    <form method="post" action="/dev-auth/select">
      <input type="hidden" name="return_to" value="${escapeHtml(safeReturnTo(returnTo))}" />
      <label>Tenant<select id="tenant" name="tenant">${tenantOptions}</select></label>
      <label>User<select id="persona" name="persona"></select></label>
      <button type="submit">Open Agor</button>
    </form>
    <aside>Compose-only fixture · tenant authority enters Agor through a signed external-launch assertion.</aside>
  </main>
  <script>
    const personas = ${personaJson};
    const tenant = document.querySelector('#tenant');
    const persona = document.querySelector('#persona');
    function renderUsers() {
      persona.replaceChildren(...personas.filter((item) => item.tenantId === tenant.value).map((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name + ' — ' + item.role;
        return option;
      }));
    }
    tenant.addEventListener('change', renderUsers);
    renderUsers();
  </script>
</body>
</html>`;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

export function createDevLauncher(options) {
  const publicOrigin = new URL(options.publicOrigin).origin;
  const issuer = options.issuer;
  const audience = options.audience;
  const instanceId = options.instanceId;
  const sharedSecret = options.sharedSecret;
  const now = options.now ?? Date.now;
  const codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
  const assertionTtlSeconds = options.assertionTtlSeconds ?? DEFAULT_ASSERTION_TTL_SECONDS;
  const maxPendingCodes = options.maxPendingCodes ?? DEFAULT_MAX_PENDING_CODES;
  const codes = new Map();

  if (!issuer || !audience || !instanceId || !sharedSecret) {
    throw new Error('issuer, audience, instanceId, and sharedSecret are required');
  }
  if (!Number.isSafeInteger(maxPendingCodes) || maxPendingCodes < 1) {
    throw new Error('maxPendingCodes must be a positive integer');
  }

  function preparePendingCodes(timestamp) {
    for (const [code, record] of codes) {
      if (record.expiresAt <= timestamp) codes.delete(code);
    }
    while (codes.size >= maxPendingCodes) {
      const oldestCode = codes.keys().next().value;
      if (oldestCode === undefined) break;
      codes.delete(oldestCode);
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', publicOrigin);
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return json(response, 200, { ok: true });
      }

      if (request.method === 'GET' && ['/dev-auth', '/dev-auth/'].includes(url.pathname)) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
        return response.end(renderPicker(publicOrigin, url.searchParams.get('return_to')));
      }

      if (request.method === 'POST' && url.pathname === '/dev-auth/select') {
        const form = new URLSearchParams(await readBody(request));
        const persona = PERSONAS_BY_ID.get(form.get('persona'));
        if (!persona || form.get('tenant') !== persona.tenantId) {
          return json(response, 400, { error: 'Unknown development persona' });
        }
        const timestamp = now();
        preparePendingCodes(timestamp);
        const launchCode = randomBytes(24).toString('base64url');
        codes.set(launchCode, { persona, expiresAt: timestamp + codeTtlMs });
        response.writeHead(303, {
          location: buildLaunchRedirect(publicOrigin, form.get('return_to'), launchCode),
          'cache-control': 'no-store',
        });
        return response.end();
      }

      if (request.method === 'POST' && url.pathname === '/exchange') {
        const parsed = JSON.parse(await readBody(request));
        const launchCode = typeof parsed.launch_code === 'string' ? parsed.launch_code : '';
        const record = codes.get(launchCode);
        // Consume before any further validation so even a malformed exchange
        // cannot race a valid peer and replay the same development identity.
        codes.delete(launchCode);
        if (
          !record ||
          record.expiresAt <= now() ||
          parsed.audience !== audience ||
          parsed.instance_id !== instanceId
        ) {
          return json(response, 401, { error: 'Invalid or expired launch code' });
        }

        const issuedAt = Math.floor(now() / 1000);
        const persona = record.persona;
        const assertion = signHs256(
          {
            iss: issuer,
            aud: audience,
            sub: persona.subject,
            exp: issuedAt + assertionTtlSeconds,
            iat: issuedAt,
            jti: randomUUID(),
            instance_id: instanceId,
            provider: 'agor-ha-dev-launcher',
            tenant_id: persona.tenantId,
            email: persona.email,
            email_verified: true,
            name: persona.name,
            role: persona.role,
          },
          sharedSecret
        );
        return json(response, 200, { assertion });
      }

      return json(response, 404, { error: 'Not found' });
    } catch {
      return json(response, 400, { error: 'Invalid request' });
    }
  });

  return { server, personas: HA_DEV_PERSONAS };
}

export function startDevLauncherFromEnvironment(env = process.env) {
  const port = Number.parseInt(env.PORT ?? '4000', 10);
  const launcher = createDevLauncher({
    publicOrigin: env.AGOR_HA_PUBLIC_ORIGIN ?? 'http://localhost:3030',
    issuer: env.AGOR_EXTERNAL_LAUNCH_ISSUER ?? 'http://dev-launcher:4000',
    audience: env.AGOR_EXTERNAL_LAUNCH_AUDIENCE ?? 'agor-runtime:ha-dev',
    instanceId: env.AGOR_EXTERNAL_LAUNCH_INSTANCE_ID ?? 'agor-ha-dev',
    sharedSecret: env.AGOR_EXTERNAL_LAUNCH_SHARED_SECRET ?? '',
  });
  launcher.server.listen(port, '0.0.0.0', () => {
    console.log(`[ha-dev-launcher] listening on :${port} personas=${HA_DEV_PERSONAS.length}`);
  });
  return launcher;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDevLauncherFromEnvironment();
}
