/**
 * GitHub App Setup Service
 *
 * Express routes for creating and configuring a GitHub App for Agor:
 *
 * 1. POST /api/github/setup/state     — Authenticated endpoint that issues a
 *                                        one-time CSRF state token bound to the
 *                                        requesting admin's user_id. The UI
 *                                        calls this first, then opens the
 *                                        instruction page with the token.
 * 2. GET  /api/github/setup/new        — Shows instruction page, links to GitHub
 *                                        with URL parameters to pre-fill the App
 *                                        creation form. Embeds the state token
 *                                        in `setup_url` so it's returned on the
 *                                        post-install redirect.
 * 3. GET  /api/github/setup/callback   — Consumes the state token (one-shot),
 *                                        verifying the install originated from
 *                                        an authenticated admin session. Shows
 *                                        the installation_id so the admin can
 *                                        finish configuring the channel.
 * 4. GET  /api/github/installations    — Lists installations for a GitHub App
 *                                        so the admin can pick which org/repos
 *                                        to connect.
 *
 * We use GitHub's "URL parameters" registration method instead of the Manifest POST
 * flow because cross-origin POST bodies get dropped during GitHub's auth redirect
 * chains (2FA, sudo confirmation).
 *
 * See: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters
 *
 * These are plain Express routes (not FeathersJS services) because they involve
 * browser redirects and HTML responses, which don't fit the Feathers service model.
 */

import { type AgorConfig, resolveTenantContext } from '@agor/core/config';
import { runWithTenantDatabaseScope, type TenantScopeAwareDatabase } from '@agor/core/db';
import { type AuthenticatedParams, hasMinimumRole, ROLES } from '@agor/core/types';
import type express from 'express';
import { escapeHtml } from '../utils/html.js';
import { consumeInstallState, issueInstallState } from './github-install-state.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract a bearer JWT from the Authorization header. Returns null if absent.
 */
function readBearerToken(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Authenticate an Express request against the Feathers JWT strategy.
 * Returns the authenticated user or null if auth fails.
 */
async function authenticateRequest(
  // biome-ignore lint/suspicious/noExplicitAny: FeathersExpress app has mixed typing
  app: any,
  req: express.Request,
  config: AgorConfig
): Promise<{ user_id: string; role?: string; tenantId: string } | null> {
  const token = readBearerToken(req);
  if (!token) return null;
  try {
    const authService = app.service('authentication');
    const headers = req.headers as Record<string, unknown>;
    // Authentication establishes params.tenant from the signed runtime token.
    // Preserve that same params object for tenant resolution so a request header
    // cannot replace the identity under which the user was authenticated.
    const authParams: AuthenticatedParams = { headers };
    const result = await authService.create({ strategy: 'jwt', accessToken: token }, authParams);
    const user = result?.user as
      | { user_id?: string; role?: string; tenant_id?: string }
      | undefined;
    if (!user?.user_id) return null;
    const authentication = result?.authentication as { payload?: unknown } | undefined;
    // The authentication service has already validated and resolved
    // `params.tenant`; treat that signed identity as authoritative. Re-running
    // resolution with the raw request headers would turn a conflicting trusted
    // header into a 401 even though authentication succeeded (and could allow
    // request metadata to influence the authenticated identity).
    const tenant =
      authParams.tenant ??
      resolveTenantContext(config, {
        params: {
          ...authParams,
          user,
          authentication: authentication ?? authParams.authentication,
          headers,
        },
        authPayload: authentication?.payload,
        headers,
      });
    return { user_id: user.user_id, role: user.role, tenantId: tenant.tenant_id };
  } catch {
    return null;
  }
}

/**
 * HTML shell for helpful 401/400 error pages.
 *
 * ALL interpolated values (including `body`) are HTML-escaped. Callers
 * should pass plain text, not pre-rendered HTML — this is a safety rail
 * against future dynamic content leaking unescaped into the response.
 */
function renderErrorPage(opts: {
  title: string;
  heading: string;
  body: string;
  uiUrl: string;
}): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(opts.title)} — Agor</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 520px; text-align: center; }
    h2 { margin: 0 0 12px; color: #f85149; }
    p { color: #8b949e; margin: 0 0 12px; line-height: 1.6; }
    .btn { display: inline-block; margin-top: 16px; background: #238636; color: #fff; border-radius: 6px; padding: 10px 20px; font-weight: 600; text-decoration: none; }
    .btn:hover { background: #2ea043; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${escapeHtml(opts.heading)}</h2>
    <p>${escapeHtml(opts.body)}</p>
    <a class="btn" href="${escapeHtml(opts.uiUrl)}">Return to Agor</a>
  </div>
</body>
</html>`;
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * POST /api/github/setup/state
 *
 * Authenticated endpoint that issues a one-time CSRF state token bound to
 * the calling admin's user_id. The UI fetches this before opening the
 * install instruction page and passes the token along as a query parameter.
 */
// biome-ignore lint/suspicious/noExplicitAny: Feathers app typing
function handleIssueState(app: any, config: AgorConfig) {
  return async (req: express.Request, res: express.Response) => {
    const authed = await authenticateRequest(app, req, config);
    if (!authed) {
      res.status(401).json({ error: 'Authentication required to initiate GitHub App install' });
      return;
    }
    // Admin-or-higher required. `hasMinimumRole` normalizes legacy 'owner' to
    // 'superadmin' and admits both 'admin' and 'superadmin'.
    if (!hasMinimumRole(authed.role, ROLES.ADMIN)) {
      res.status(403).json({ error: 'Admin role required to initiate GitHub App install' });
      return;
    }
    const state = issueInstallState(authed.user_id, authed.tenantId);
    res.json({ state });
  };
}

/**
 * GET /api/github/setup/new
 *
 * Shows an instruction page then links to GitHub's app creation page
 * with fields pre-filled via URL query parameters. Includes a reminder
 * to uncheck "Active" under Webhook (GitHub ignores webhook_active=false
 * in URL params).
 *
 * Query params:
 *   ?name=MyApp     — Custom app name (default: "Agor")
 *   ?org=my-org     — Create under an org (default: user's personal account)
 *   ?state=XYZ      — CSRF state token previously issued via POST /state.
 *                     Required — embedded in setup_url so GitHub returns it
 *                     on the post-install redirect.
 */
function handleNewApp(uiUrl: string, daemonUrl: string) {
  return (req: express.Request, res: express.Response) => {
    const appName = (req.query.name as string) || 'Agor';
    const org = req.query.org as string | undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : '';

    if (!state) {
      res.setHeader('Content-Type', 'text/html');
      res.status(401).send(
        renderErrorPage({
          title: 'Install session missing',
          heading: 'Install session missing',
          body: 'Open this page from the Agor Settings → Gateway Channels flow. The install needs a one-time token that is only issued from an authenticated session.',
          uiUrl,
        })
      );
      return;
    }

    // GitHub's app creation endpoint
    const githubUrl = org
      ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
      : 'https://github.com/settings/apps/new';

    // Pre-fill the form using GitHub's URL parameters approach.
    // See: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters
    const params = new URLSearchParams();
    params.set('name', appName);
    params.set('url', 'https://agor.live');
    params.set('public', 'false');
    // Do NOT set webhook_active — GitHub docs say "Webhook is disabled by default"
    // when the parameter is omitted. Setting it to any value (even "false") enables it.
    // setup_url points to the daemon callback — GitHub redirects the browser there
    // after installation with ?installation_id=ID (and our state param preserved).
    // Embed state in setup_url so GitHub echoes it back post-install.
    const setupUrl = new URL(`${daemonUrl}/api/github/setup/callback`);
    setupUrl.searchParams.set('state', state);
    params.set('setup_url', setupUrl.toString());
    // Permissions
    params.set('issues', 'write');
    params.set('pull_requests', 'write');
    params.set('contents', 'read');

    const githubLink = `${githubUrl}?${params.toString()}`;

    // Serve an instruction page instead of direct redirect,
    // because GitHub doesn't respect webhook_active=false in URL params.
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Create GitHub App — Agor</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 520px; }
    h2 { margin: 0 0 16px; text-align: center; }
    .steps { margin: 0 0 24px; padding-left: 20px; line-height: 1.8; }
    .steps li { margin-bottom: 8px; }
    .highlight { background: #30363d; padding: 2px 6px; border-radius: 4px; color: #f0883e; font-weight: 600; }
    .btn { display: block; background: #238636; color: #fff; border: none; border-radius: 6px; padding: 12px 24px; font-size: 16px; cursor: pointer; font-weight: 600; text-align: center; text-decoration: none; }
    .btn:hover { background: #2ea043; }
    .hint { font-size: 12px; color: #8b949e; margin-top: 16px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Create GitHub App for Agor</h2>
    <ol class="steps">
      <li>Click the button below to open GitHub</li>
      <li>Scroll to <strong>Webhook</strong> and <span class="highlight">uncheck "Active"</span><br><span style="color:#8b949e;font-size:13px">Agor uses polling, not webhooks</span></li>
      <li>Scroll down and click <strong>"Create GitHub App"</strong></li>
      <li>Install the app on your org when prompted</li>
      <li>You'll be redirected back to Agor to finish setup</li>
    </ol>
    <a class="btn" href="${escapeHtml(githubLink)}" target="_blank" rel="noopener noreferrer">
      Open GitHub App Settings
    </a>
    <p class="hint">The form will be pre-filled with the right permissions for Agor.</p>
  </div>
</body>
</html>`);
  };
}

/**
 * GET /api/github/setup/callback?installation_id=ID&state=XYZ
 *
 * GitHub redirects the browser here after the app is installed.
 * Verifies the CSRF state token (one-shot), then shows the installation_id
 * for the admin to enter in the channel setup form. The callback deliberately
 * does not select or mutate a channel: the create flow runs before a channel
 * exists, and multiple GitHub channels may exist in the same tenant.
 *
 * Authentication: callers do not (and cannot) attach a Bearer header here
 * because the request is a browser redirect from GitHub. Authentication is
 * proven by the state token — it is only issued from an authenticated
 * admin session (POST /api/github/setup/state) and is validated here.
 */
function handleSetupCallback(uiUrl: string) {
  return async (req: express.Request, res: express.Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const installationIdRaw =
      typeof req.query.installation_id === 'string' ? req.query.installation_id : undefined;

    const consumed = consumeInstallState(state);
    if (!consumed.ok) {
      res.setHeader('Content-Type', 'text/html');
      const status = consumed.reason === 'missing' ? 401 : 400;
      const heading =
        consumed.reason === 'missing'
          ? 'Install session missing'
          : consumed.reason === 'expired'
            ? 'Install session expired'
            : 'Install session invalid';
      const body =
        consumed.reason === 'missing'
          ? 'This callback is missing its one-time install token. Restart the install from Agor Settings → Gateway Channels.'
          : consumed.reason === 'expired'
            ? 'The one-time install token expired (10 min TTL). Restart the install from Agor Settings → Gateway Channels.'
            : 'The one-time install token was not recognized or has already been used. Restart the install from Agor Settings → Gateway Channels.';
      res.status(status).send(renderErrorPage({ title: heading, heading, body, uiUrl }));
      return;
    }

    if (!installationIdRaw) {
      res.status(400).send('Missing installation_id parameter');
      return;
    }

    const installationIdNum = Number(installationIdRaw);
    if (!Number.isSafeInteger(installationIdNum) || installationIdNum <= 0) {
      res.status(400).send('installation_id must be a positive integer');
      return;
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>GitHub App Installed — Agor</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 420px; text-align: center; }
    h2 { margin: 0 0 12px; color: #3fb950; }
    p { color: #8b949e; margin: 0; line-height: 1.6; }
    code { background: #30363d; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>GitHub App Installed</h2>
    <p>Installation ID <code>${escapeHtml(installationIdNum)}</code></p>
    <p style="margin-top: 12px;">Return to Agor and enter this ID to finish configuring the gateway channel.</p>
  </div>
</body>
</html>`);
  };
}

/**
 * GET /api/github/installations?app_id=APP_ID&channel_id=CHANNEL_ID
 *
 * Lists installations for an existing GitHub gateway channel. The caller must
 * be an authenticated admin in the channel's tenant.
 */
function handleListInstallations(
  // biome-ignore lint/suspicious/noExplicitAny: FeathersExpress app has mixed typing
  app: any,
  db: TenantScopeAwareDatabase,
  config: AgorConfig
) {
  return async (req: express.Request, res: express.Response) => {
    const authed = await authenticateRequest(app, req, config);
    if (!authed) {
      res.status(401).json({ error: 'Authentication required to list GitHub App installations' });
      return;
    }
    if (!hasMinimumRole(authed.role, ROLES.ADMIN)) {
      res.status(403).json({ error: 'Admin role required to list GitHub App installations' });
      return;
    }

    const appIdStr = typeof req.query.app_id === 'string' ? req.query.app_id : undefined;
    const channelId = typeof req.query.channel_id === 'string' ? req.query.channel_id : undefined;

    if (!appIdStr) {
      res.status(400).json({ error: 'Missing app_id query parameter' });
      return;
    }

    const appId = Number(appIdStr);
    if (!Number.isSafeInteger(appId) || appId <= 0) {
      res.status(400).json({ error: 'app_id must be a positive integer' });
      return;
    }

    // Resolve the private key
    let privateKey: string | undefined;

    if (channelId) {
      privateKey = await runWithTenantDatabaseScope(db, authed.tenantId, async (tenantDb) => {
        // Resolve credentials only from a GitHub channel in the caller's tenant.
        const { GatewayChannelRepository } = await import('@agor/core/db');
        const channelRepo = new GatewayChannelRepository(tenantDb);
        const channel = await channelRepo.findById(channelId);
        if (channel?.channel_type === 'github' && channel.config) {
          const channelConfig = channel.config as Record<string, unknown>;
          if (channelConfig.app_id === appId && typeof channelConfig.private_key === 'string') {
            return channelConfig.private_key;
          }
        }
        return undefined;
      });
    }

    if (!privateKey) {
      res.status(400).json({
        error: 'Could not resolve private key. Provide channel_id for an existing channel.',
      });
      return;
    }

    try {
      // Create a JWT for the GitHub App and list installations
      const { createAppAuth } = await import('@octokit/auth-app');
      const { Octokit } = await import('@octokit/rest');

      const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId,
          privateKey,
        },
      });

      const { data } = await octokit.apps.listInstallations({ per_page: 100 });

      // Return a simplified list
      const installations = data.map((inst: (typeof data)[number]) => ({
        id: inst.id,
        account: inst.account
          ? {
              login: 'login' in inst.account ? inst.account.login : undefined,
              type: inst.account.type,
              avatar_url: inst.account.avatar_url,
            }
          : null,
        repository_selection: inst.repository_selection,
        html_url: inst.html_url,
        app_slug: inst.app_slug,
        target_type: inst.target_type,
        created_at: inst.created_at,
      }));

      res.json({ installations });
    } catch (error) {
      console.error('[github-app-setup] List installations error:', error);
      res.status(502).json({ error: 'Failed to list GitHub App installations' });
    }
  };
}

// ============================================================================
// Route Registration
// ============================================================================

/**
 * Register all GitHub App setup routes on the Express app.
 *
 * Call this from the daemon's index.ts after database initialization.
 * The Feathers app has Express methods (get/post/use) via feathersExpress.
 */
export function registerGitHubAppSetupRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: FeathersExpress app has Express methods but TS doesn't expose them cleanly
  app: any,
  opts: {
    uiUrl: string;
    daemonUrl: string;
    db: TenantScopeAwareDatabase;
    config: AgorConfig;
  }
): void {
  app.post('/api/github/setup/state', handleIssueState(app, opts.config));
  app.get('/api/github/setup/new', handleNewApp(opts.uiUrl, opts.daemonUrl));
  app.get('/api/github/setup/callback', handleSetupCallback(opts.uiUrl));
  app.get('/api/github/installations', handleListInstallations(app, opts.db, opts.config));

  console.log(
    '[github-app-setup] Routes registered: POST /state, GET /setup/new, /setup/callback, /installations'
  );
}

// Internal test hooks (for unit tests only).
export const __testables = {
  escapeHtml,
  readBearerToken,
  handleIssueState,
  handleListInstallations,
  handleSetupCallback,
  handleNewApp,
};
