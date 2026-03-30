/**
 * GitHub App Setup Service
 *
 * Express routes for creating and configuring a GitHub App for Agor:
 *
 * 1. GET  /api/github/setup/new        — Shows instruction page, then links to GitHub
 *                                         with URL parameters to pre-fill the App creation
 *                                         form. After install, GitHub redirects the browser
 *                                         directly to the Agor UI with ?installation_id=ID.
 * 2. GET  /api/github/installations     — Lists installations for a GitHub App so the
 *                                         admin can pick which org/repos to connect.
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

import type { Database } from '@agor/core/db';
import type express from 'express';

// ============================================================================
// Route Handlers
// ============================================================================

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
 */
function handleNewApp(uiUrl: string) {
  return (req: express.Request, res: express.Response) => {
    const appName = (req.query.name as string) || 'Agor';
    const org = req.query.org as string | undefined;

    // GitHub's app creation endpoint
    const githubUrl = org
      ? `https://github.com/organizations/${org}/settings/apps/new`
      : 'https://github.com/settings/apps/new';

    // Pre-fill the form using GitHub's URL parameters approach.
    // See: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters
    const params = new URLSearchParams();
    params.set('name', appName);
    params.set('url', 'https://agor.live');
    params.set('public', 'false');
    // Do NOT set webhook_active — GitHub docs say "Webhook is disabled by default"
    // when the parameter is omitted. Setting it to any value (even "false") enables it.
    // setup_url points to the UI — GitHub redirects the browser there after
    // installation with ?installation_id=ID. The UI detects this and opens
    // the settings modal to complete channel setup.
    params.set('setup_url', `${uiUrl}/gateway/github/setup`);
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
    <a class="btn" href="${githubLink}" target="_blank" rel="noopener noreferrer">
      Open GitHub App Settings
    </a>
    <p class="hint">The form will be pre-filled with the right permissions for Agor.</p>
  </div>
</body>
</html>`);
  };
}

// No daemon callback route needed — setup_url points directly to the UI.
// GitHub redirects the browser to: {uiUrl}/gateway/github/setup?installation_id=ID
// The UI's useEffect detects this and opens the settings modal.

/**
 * GET /api/github/installations?app_id=APP_ID&private_key=...
 *
 * Lists installations for a GitHub App. Requires the app's private_key
 * to create a JWT for authentication.
 *
 * The private key can come from:
 *   1. A query param (during setup flow, from the UI)
 *   2. An existing gateway channel (query param: channel_id)
 */
function handleListInstallations(_db: Database) {
  return async (req: express.Request, res: express.Response) => {
    const appIdStr = req.query.app_id as string | undefined;
    const channelId = req.query.channel_id as string | undefined;

    if (!appIdStr) {
      res.status(400).json({ error: 'Missing app_id query parameter' });
      return;
    }

    const appId = Number(appIdStr);
    if (Number.isNaN(appId)) {
      res.status(400).json({ error: 'app_id must be a number' });
      return;
    }

    // Resolve the private key
    let privateKey: string | undefined;

    if (channelId) {
      // From an existing gateway channel
      const { GatewayChannelRepository } = await import('@agor/core/db');
      const channelRepo = new GatewayChannelRepository(_db);
      const channel = await channelRepo.findById(channelId);
      if (channel?.config) {
        const config = channel.config as Record<string, unknown>;
        if (config.app_id === appId && typeof config.private_key === 'string') {
          privateKey = config.private_key;
        }
      }
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
    db: Database;
  }
): void {
  app.get('/api/github/setup/new', handleNewApp(opts.uiUrl));
  app.get('/api/github/installations', handleListInstallations(opts.db));

  console.log('[github-app-setup] Routes registered: /api/github/setup/new, installations');
}
