/**
 * GitHub App Setup Service
 *
 * Express routes for the GitHub App Manifest flow:
 *
 * 1. GET  /api/github/manifest          — Returns an HTML auto-submit form that POSTs the
 *                                          App Manifest to GitHub (browser redirects there).
 * 2. GET  /api/github/manifest/callback  — GitHub redirects here with ?code=CODE after the
 *                                          user creates the App. Exchanges the code for
 *                                          credentials and redirects the browser back to the UI.
 * 3. GET  /api/github/installations      — Lists installations for a GitHub App so the admin
 *                                          can pick which org/repos to connect.
 *
 * These are plain Express routes (not FeathersJS services) because they involve
 * browser redirects and HTML responses, which don't fit the Feathers service model.
 */

import { randomBytes } from 'node:crypto';
import type { Database } from '@agor/core/db';
import type express from 'express';

// ============================================================================
// Types
// ============================================================================

/** Credentials returned by GitHub after exchanging the manifest code */
interface ManifestConversionResult {
  id: number; // app_id
  slug: string; // URL-friendly app name
  pem: string; // private key (PEM format)
  webhook_secret: string;
  client_id: string;
  client_secret: string;
  html_url: string;
  owner: {
    login: string;
    type: string; // "Organization" | "User"
  };
}

/** Temporary storage for setup credentials (in-memory, keyed by token) */
interface PendingSetup {
  app_id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  owner: string;
  owner_type: string;
  html_url: string;
  created_at: number;
}

// In-memory store for pending setup credentials.
// Keyed by a random token, expires after 10 minutes.
const pendingSetups = new Map<string, PendingSetup>();
const PENDING_SETUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Clean up expired pending setups */
function cleanExpiredSetups(): void {
  const now = Date.now();
  for (const [token, setup] of pendingSetups) {
    if (now - setup.created_at > PENDING_SETUP_TTL_MS) {
      pendingSetups.delete(token);
    }
  }
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Build the App Manifest JSON.
 *
 * See: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */
function buildManifest(opts: { daemonUrl: string; appName?: string }): Record<string, unknown> {
  return {
    name: opts.appName || 'Agor',
    url: opts.daemonUrl,
    hook_attributes: { active: false }, // We poll, no webhooks needed
    redirect_url: `${opts.daemonUrl}/api/github/manifest/callback`,
    public: false,
    default_permissions: {
      issues: 'write',
      pull_requests: 'write',
      contents: 'read',
    },
    default_events: [], // No webhook events — we use polling
  };
}

/**
 * GET /api/github/manifest
 *
 * Returns an HTML page with an auto-submit form that POSTs the manifest
 * to GitHub's app creation endpoint. The browser handles the redirect.
 *
 * Query params:
 *   ?name=MyApp     — Custom app name (default: "Agor")
 *   ?org=my-org     — Create under an org (default: user's personal account)
 */
function handleManifest(daemonUrl: string) {
  return (req: express.Request, res: express.Response) => {
    const appName = (req.query.name as string) || undefined;
    const org = req.query.org as string | undefined;

    const manifest = buildManifest({ daemonUrl, appName });
    const manifestJson = JSON.stringify(manifest);

    // GitHub's manifest creation endpoint
    const githubUrl = org
      ? `https://github.com/organizations/${org}/settings/apps/new`
      : 'https://github.com/settings/apps/new';

    // Return an HTML form that auto-submits to GitHub.
    // The manifest must be POSTed as a form field named "manifest".
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head><title>Creating GitHub App...</title></head>
<body>
  <p>Redirecting to GitHub to create the app...</p>
  <form id="manifest-form" action="${githubUrl}" method="post">
    <input type="hidden" name="manifest" value='${manifestJson.replace(/'/g, '&#39;')}' />
  </form>
  <script>document.getElementById('manifest-form').submit();</script>
</body>
</html>`);
  };
}

/**
 * GET /api/github/manifest/callback?code=CODE
 *
 * GitHub redirects here after the user creates the App.
 * Exchanges the code for credentials, stores them temporarily,
 * and redirects the browser to the UI with a setup token.
 */
function handleManifestCallback(uiUrl: string) {
  return async (req: express.Request, res: express.Response) => {
    const code = req.query.code as string | undefined;

    if (!code) {
      res.status(400).json({ error: 'Missing code parameter' });
      return;
    }

    try {
      // Exchange the code for app credentials
      // https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest#3-you-exchange-the-temporary-code-to-retrieve-the-app-configuration
      const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
        },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[github-app-setup] Manifest exchange failed:', response.status, errorBody);
        res.status(502).json({
          error: 'Failed to exchange manifest code with GitHub',
          status: response.status,
        });
        return;
      }

      const result = (await response.json()) as ManifestConversionResult;

      // Store credentials temporarily, keyed by a random token.
      // The UI will fetch them via GET /api/github/setup/:token.
      cleanExpiredSetups();
      const setupToken = randomBytes(32).toString('hex');
      pendingSetups.set(setupToken, {
        app_id: result.id,
        slug: result.slug,
        pem: result.pem,
        webhook_secret: result.webhook_secret,
        owner: result.owner.login,
        owner_type: result.owner.type,
        html_url: result.html_url,
        created_at: Date.now(),
      });

      console.log(
        `[github-app-setup] App created: ${result.slug} (id=${result.id}) for ${result.owner.login}`
      );

      // Redirect browser to UI with non-sensitive params + setup token.
      // The UI will use the token to fetch the PEM via a separate API call.
      const params = new URLSearchParams({
        setup_token: setupToken,
        app_id: String(result.id),
        slug: result.slug,
        owner: result.owner.login,
        html_url: result.html_url,
      });

      res.redirect(`${uiUrl}/gateway/github/setup?${params.toString()}`);
    } catch (error) {
      console.error('[github-app-setup] Manifest callback error:', error);
      res.status(500).json({ error: 'Internal error during manifest exchange' });
    }
  };
}

/**
 * GET /api/github/setup/:token
 *
 * Retrieves the pending setup credentials (including PEM) for a setup token.
 * Token remains valid until TTL expiry (10 min) so the UI can make multiple
 * calls (e.g., list installations, then fetch credentials to create the channel).
 */
function handleGetSetup() {
  return (req: express.Request, res: express.Response) => {
    const { token } = req.params;

    cleanExpiredSetups();
    const setup = pendingSetups.get(token);

    if (!setup) {
      res.status(404).json({ error: 'Setup token not found or expired' });
      return;
    }

    res.json(setup);
  };
}

/**
 * GET /api/github/installations?app_id=APP_ID
 *
 * Lists installations for a GitHub App. Requires the app's private_key
 * to create a JWT for authentication.
 *
 * The private key can come from:
 *   1. A pending setup token (query param: setup_token)
 *   2. An existing gateway channel (query param: channel_id)
 */
function handleListInstallations(_db: Database) {
  return async (req: express.Request, res: express.Response) => {
    const appIdStr = req.query.app_id as string | undefined;
    const setupToken = req.query.setup_token as string | undefined;
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

    if (setupToken) {
      // From a pending setup (during initial creation flow)
      cleanExpiredSetups();
      const setup = pendingSetups.get(setupToken);
      if (setup && setup.app_id === appId) {
        privateKey = setup.pem;
      }
    }

    if (!privateKey && channelId) {
      // From an existing gateway channel
      const { GatewayChannelRepository } = await import('@agor/core/db');
      const channelRepo = new GatewayChannelRepository(_db);
      const channel = await channelRepo.findById(channelId);
      if (channel && channel.config) {
        const config = channel.config as Record<string, unknown>;
        if (config.app_id === appId && typeof config.private_key === 'string') {
          privateKey = config.private_key;
        }
      }
    }

    if (!privateKey) {
      res.status(400).json({
        error: 'Could not resolve private key. Provide setup_token or channel_id.',
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
    daemonUrl: string;
    uiUrl: string;
    db: Database;
  }
): void {
  app.get('/api/github/manifest', handleManifest(opts.daemonUrl));
  app.get('/api/github/manifest/callback', handleManifestCallback(opts.uiUrl));
  app.get('/api/github/setup/:token', handleGetSetup());
  app.get('/api/github/installations', handleListInstallations(opts.db));

  console.log(
    '[github-app-setup] Routes registered: /api/github/manifest, callback, setup, installations'
  );
}
