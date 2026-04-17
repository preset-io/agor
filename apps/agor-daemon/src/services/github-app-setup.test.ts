/**
 * Unit tests for the GitHub App setup routes.
 *
 * These tests stub GatewayChannelRepository via vi.mock so they do not
 * need a real database. They exercise:
 *  - POST /api/github/setup/state auth + admin-role gating
 *  - GET  /api/github/setup/callback state-nonce validation
 *  - HTML escaping of attacker-controlled fields (channel name)
 *  - GET  /api/github/setup/new 401-ing without state
 */

import type express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetInstallStateForTests, issueInstallState } from './github-install-state.js';

// --- Stub GatewayChannelRepository before importing the module under test --

const mockFindAll = vi.fn();
const mockFindById = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@agor/core/db', () => {
  return {
    GatewayChannelRepository: class {
      findAll = mockFindAll;
      findById = mockFindById;
      update = mockUpdate;
    },
  };
});

import { __testables, registerGitHubAppSetupRoutes } from './github-app-setup.js';

// --- Helpers ------------------------------------------------------------

function mockRes() {
  const res: Partial<express.Response> & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  } = {
    statusCode: 200,
    body: undefined,
    headers: {},
  };
  res.status = vi.fn(function (this: typeof res, code: number) {
    this.statusCode = code;
    return this as unknown as express.Response;
  }) as unknown as express.Response['status'];
  res.send = vi.fn(function (this: typeof res, body: unknown) {
    this.body = body;
    return this as unknown as express.Response;
  }) as unknown as express.Response['send'];
  res.json = vi.fn(function (this: typeof res, body: unknown) {
    this.body = body;
    return this as unknown as express.Response;
  }) as unknown as express.Response['json'];
  res.setHeader = vi.fn(function (this: typeof res, key: string, value: string) {
    this.headers[key] = value;
    return this as unknown as express.Response;
  }) as unknown as express.Response['setHeader'];
  return res;
}

function mockReq(overrides: Partial<express.Request> = {}): express.Request {
  return {
    query: {},
    headers: {},
    ...overrides,
  } as unknown as express.Request;
}

/** Build a minimal Feathers-like app with a stubbed authentication service. */
function mockApp(authResult: unknown, authShouldThrow = false) {
  const authService = {
    create: vi.fn(async () => {
      if (authShouldThrow) throw new Error('bad token');
      return authResult;
    }),
  };
  const routes: Record<string, unknown> = {};
  return {
    service: (name: string) => {
      if (name === 'authentication') return authService;
      throw new Error(`unexpected service ${name}`);
    },
    get: (path: string, handler: unknown) => {
      routes[`GET ${path}`] = handler;
    },
    post: (path: string, handler: unknown) => {
      routes[`POST ${path}`] = handler;
    },
    _routes: routes,
    _authService: authService,
  };
}

// --- Tests --------------------------------------------------------------

describe('github-app-setup helpers', () => {
  it('escapeHtml encodes the five dangerous characters', () => {
    expect(__testables.escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    );
    expect(__testables.escapeHtml("it's & stuff")).toBe('it&#39;s &amp; stuff');
    expect(__testables.escapeHtml(42)).toBe('42');
    expect(__testables.escapeHtml(undefined)).toBe('');
  });

  it('readBearerToken parses Authorization: Bearer and rejects otherwise', () => {
    expect(
      __testables.readBearerToken(mockReq({ headers: { authorization: 'Bearer abc.def' } }))
    ).toBe('abc.def');
    expect(
      __testables.readBearerToken(mockReq({ headers: { authorization: 'Basic abc' } }))
    ).toBeNull();
    expect(__testables.readBearerToken(mockReq({ headers: {} }))).toBeNull();
  });
});

describe('registerGitHubAppSetupRoutes', () => {
  it('registers expected routes', () => {
    const app = mockApp({ user: { user_id: 'u1', role: 'admin' } });
    registerGitHubAppSetupRoutes(app as never, {
      uiUrl: 'http://localhost:5173',
      daemonUrl: 'http://localhost:3030',
      db: {} as never,
    });
    expect(Object.keys(app._routes).sort()).toEqual([
      'GET /api/github/installations',
      'GET /api/github/setup/callback',
      'GET /api/github/setup/new',
      'POST /api/github/setup/state',
    ]);
  });
});

describe('POST /api/github/setup/state', () => {
  beforeEach(() => {
    __resetInstallStateForTests();
    vi.clearAllMocks();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const app = mockApp(null);
    const handler = __testables.handleIssueState(app);
    const res = mockRes();
    await handler(mockReq(), res as express.Response);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string }).error).toMatch(/authentication required/i);
  });

  it('returns 401 when JWT strategy rejects the token', async () => {
    const app = mockApp(null, /* authShouldThrow */ true);
    const handler = __testables.handleIssueState(app);
    const res = mockRes();
    await handler(mockReq({ headers: { authorization: 'Bearer bogus' } }), res as express.Response);
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when the user is not admin/owner', async () => {
    const app = mockApp({ user: { user_id: 'u-member', role: 'member' } });
    const handler = __testables.handleIssueState(app);
    const res = mockRes();
    await handler(mockReq({ headers: { authorization: 'Bearer ok' } }), res as express.Response);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error?: string }).error).toMatch(/admin/i);
  });

  it('returns 200 + state for admin users', async () => {
    const app = mockApp({ user: { user_id: 'u-admin', role: 'admin' } });
    const handler = __testables.handleIssueState(app);
    const res = mockRes();
    await handler(mockReq({ headers: { authorization: 'Bearer ok' } }), res as express.Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { state?: string };
    expect(body.state).toMatch(/^[a-f0-9]+$/);
  });

  it('returns 200 + state for owner users (legacy alias for superadmin)', async () => {
    const app = mockApp({ user: { user_id: 'u-owner', role: 'owner' } });
    const handler = __testables.handleIssueState(app);
    const res = mockRes();
    await handler(mockReq({ headers: { authorization: 'Bearer ok' } }), res as express.Response);
    expect(res.statusCode).toBe(200);
    expect((res.body as { state?: string }).state).toBeTruthy();
  });

  it('returns 200 + state for superadmin users (canonical elevated role)', async () => {
    const app = mockApp({ user: { user_id: 'u-super', role: 'superadmin' } });
    const handler = __testables.handleIssueState(app);
    const res = mockRes();
    await handler(mockReq({ headers: { authorization: 'Bearer ok' } }), res as express.Response);
    expect(res.statusCode).toBe(200);
    expect((res.body as { state?: string }).state).toBeTruthy();
  });
});

describe('GET /api/github/setup/new', () => {
  beforeEach(() => {
    __resetInstallStateForTests();
  });

  it('returns 401 HTML if the state query param is missing', () => {
    const handler = __testables.handleNewApp('http://ui', 'http://daemon');
    const res = mockRes();
    handler(mockReq({ query: {} }), res as express.Response);
    expect(res.statusCode).toBe(401);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(String(res.body)).toMatch(/install session missing/i);
  });

  it('embeds state in the setup_url sent to GitHub', () => {
    const state = issueInstallState('u-admin');
    const handler = __testables.handleNewApp('http://ui', 'http://daemon');
    const res = mockRes();
    handler(mockReq({ query: { state, name: 'Agor' } }), res as express.Response);
    expect(res.statusCode).toBe(200);
    const html = String(res.body);
    // The setup_url query parameter is URL-encoded inside the GitHub link.
    const setupUrlEncoded = encodeURIComponent(
      `http://daemon/api/github/setup/callback?state=${state}`
    );
    expect(html).toContain(`setup_url=${setupUrlEncoded}`);
  });
});

describe('GET /api/github/setup/callback', () => {
  beforeEach(() => {
    __resetInstallStateForTests();
    vi.clearAllMocks();
    mockFindAll.mockResolvedValue([
      { id: 'ch-1', channel_type: 'github', name: 'prod-channel', config: {} },
    ]);
    mockUpdate.mockResolvedValue(undefined);
  });

  it('returns 401 HTML when state is missing', async () => {
    const handler = __testables.handleSetupCallback({} as never, 'http://ui');
    const res = mockRes();
    await handler(mockReq({ query: { installation_id: '1234' } }), res as express.Response);
    expect(res.statusCode).toBe(401);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(String(res.body)).toMatch(/install session missing/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 HTML when state is unknown', async () => {
    const handler = __testables.handleSetupCallback({} as never, 'http://ui');
    const res = mockRes();
    await handler(
      mockReq({ query: { installation_id: '1234', state: 'not-a-real-state' } }),
      res as express.Response
    );
    expect(res.statusCode).toBe(400);
    expect(String(res.body)).toMatch(/install session invalid/i);
  });

  it('returns 400 HTML on a second (re-use) attempt — state is one-shot', async () => {
    const state = issueInstallState('u-admin');
    const handler = __testables.handleSetupCallback({} as never, 'http://ui');

    // First call consumes the state.
    const res1 = mockRes();
    await handler(mockReq({ query: { installation_id: '42', state } }), res1 as express.Response);
    expect(res1.statusCode).toBe(200);

    // Second call with the same state must fail.
    const res2 = mockRes();
    await handler(mockReq({ query: { installation_id: '42', state } }), res2 as express.Response);
    expect(res2.statusCode).toBe(400);
  });

  it('rejects when installation_id is missing (after valid state)', async () => {
    const state = issueInstallState('u-admin');
    const handler = __testables.handleSetupCallback({} as never, 'http://ui');
    const res = mockRes();
    await handler(mockReq({ query: { state } }), res as express.Response);
    expect(res.statusCode).toBe(400);
    expect(String(res.body)).toMatch(/installation_id/);
  });

  it('rejects non-integer installation_id', async () => {
    const state = issueInstallState('u-admin');
    const handler = __testables.handleSetupCallback({} as never, 'http://ui');
    const res = mockRes();
    await handler(
      mockReq({ query: { state, installation_id: 'not-a-number' } }),
      res as express.Response
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects negative or zero installation_id', async () => {
    const handler = __testables.handleSetupCallback({} as never, 'http://ui');
    for (const bad of ['-1', '0']) {
      const state = issueInstallState('u-admin');
      const res = mockRes();
      await handler(mockReq({ query: { state, installation_id: bad } }), res as express.Response);
      expect(res.statusCode).toBe(400);
      expect(String(res.body)).toMatch(/positive integer/);
    }
  });

  it('rejects unsafe-large installation_id (beyond Number.MAX_SAFE_INTEGER)', async () => {
    const state = issueInstallState('u-admin');
    const handler = __testables.handleSetupCallback({} as never, 'http://ui');
    const res = mockRes();
    await handler(
      mockReq({ query: { state, installation_id: '99999999999999999999' } }),
      res as express.Response
    );
    expect(res.statusCode).toBe(400);
  });

  it('happy path writes installation_id and returns HTML with escaped channel name', async () => {
    // Channel name contains a <script> tag — must render escaped.
    mockFindAll.mockResolvedValue([
      {
        id: 'ch-1',
        channel_type: 'github',
        name: '<script>alert(1)</script>',
        config: { existing: 'x' },
      },
    ]);
    const state = issueInstallState('u-admin');
    const handler = __testables.handleSetupCallback({} as never, 'http://ui');
    const res = mockRes();
    await handler(mockReq({ query: { state, installation_id: '9001' } }), res as express.Response);
    expect(res.statusCode).toBe(200);
    const html = String(res.body);
    // Raw script tag must NOT appear.
    expect(html).not.toContain('<script>alert(1)</script>');
    // Encoded form should appear.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // installation_id was persisted with existing config merged.
    expect(mockUpdate).toHaveBeenCalledWith('ch-1', {
      config: { existing: 'x', installation_id: 9001 },
    });
  });

  it('returns 404 when no GitHub channel exists', async () => {
    mockFindAll.mockResolvedValue([
      { id: 'ch-slack', channel_type: 'slack', name: 'x', config: {} },
    ]);
    const state = issueInstallState('u-admin');
    const handler = __testables.handleSetupCallback({} as never, 'http://ui');
    const res = mockRes();
    await handler(mockReq({ query: { state, installation_id: '42' } }), res as express.Response);
    expect(res.statusCode).toBe(404);
  });
});

afterEach(() => {
  __resetInstallStateForTests();
});
