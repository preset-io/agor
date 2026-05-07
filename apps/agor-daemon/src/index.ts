/**
 * Agor Daemon
 *
 * FeathersJS backend providing REST + WebSocket API for session management.
 * Auto-started by CLI, provides unified interface for GUI and CLI clients.
 *
 * This file is a slim orchestrator — all logic lives in extracted modules:
 *   - register-services.ts  — FeathersJS service registration
 *   - register-hooks.ts     — service hooks (before/after/error)
 *   - register-routes.ts    — auth config, REST routes, tier hooks, error handler
 *   - startup.ts            — orphan cleanup, health, scheduler, shutdown
 *   - executor-tracking.ts  — executor PID tracking
 *   - oauth-cache.ts        — OAuth 2.1 token cache
 */

import 'dotenv/config';

// Patch console methods to respect LOG_LEVEL env var
import { patchConsole } from '@agor/core/utils/logger';

patchConsole();

import type { AgorConfig, ResolvedSecurity } from '@agor/core/config';
import { loadConfig, loadConfigFromFile, resolveSecurity } from '@agor/core/config';
import { getDatabaseUrl } from '@agor/core/db';
import {
  authenticate,
  Forbidden,
  feathers,
  feathersExpress,
  rest,
  socketio,
} from '@agor/core/feathers';
import { registerHandlebarsHelpers } from '@agor/core/templates/handlebars-helpers';
import type { HookContext, ServiceGroupName, ServiceTier, User } from '@agor/core/types';
import { getServiceTier, isServiceEnabled } from '@agor/core/types';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import expressStaticGzip from 'express-static-gzip';
import { registerHooks } from './register-hooks.js';
import { registerRoutes } from './register-routes.js';
import { registerServices } from './register-services.js';
import { loadBuildInfo } from './setup/build-info.js';
import { buildCorsConfig, isSandpackOrigin } from './setup/cors.js';
import {
  initializeAnthropicApiKey,
  initializeAnthropicAuthToken,
  initializeAnthropicBaseUrl,
} from './setup/credentials.js';
import { initializeDatabase } from './setup/database.js';
import { securityHeaders } from './setup/security-headers.js';
import { logServicesConfig, resolveServicesConfig } from './setup/service-tiers.js';
import { configureChannels, createSocketIOConfig } from './setup/socketio.js';
import { configureSwagger } from './setup/swagger.js';
import { loadDaemonVersion } from './setup/version.js';
import { startup } from './startup.js';
import { configureDaemonUrl } from './utils/spawn-executor.js';

// Load daemon version at startup
const DAEMON_VERSION = await loadDaemonVersion(import.meta.url);

// Resolve build SHA (env > .build-info file > git > 'dev'). UI tabs capture
// this on first connect and prompt a refresh if a later handshake disagrees.
const DAEMON_BUILD_INFO = loadBuildInfo(import.meta.url);
console.log(
  `🔖 Build: sha=${DAEMON_BUILD_INFO.sha} ` +
    `builtAt=${DAEMON_BUILD_INFO.builtAt ?? 'unknown'} ` +
    `(source=${DAEMON_BUILD_INFO.source})`
);

// Database URL (env vars > config.yaml > defaults)
const DB_PATH = getDatabaseUrl();

// ============================================================================
// GLOBAL ERROR HANDLERS
// Critical for daemon stability — prevents crashes from unhandled errors
// ============================================================================

process.on('uncaughtException', (error: Error, origin: string) => {
  console.error('💥 [FATAL] Uncaught exception:', {
    error: error.message,
    stack: error.stack,
    origin,
    timestamp: new Date().toISOString(),
  });
});

process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
  console.error('💥 [FATAL] Unhandled promise rejection:', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// Public API for programmatic startup
// ============================================================================

/**
 * Options for programmatic daemon startup (used by `agor daemon start` CLI command).
 */
export interface DaemonStartOptions {
  /** Pre-loaded config (skips loadConfig()) */
  config?: AgorConfig;
  /** Path to config file (alternative to pre-loaded config) */
  configPath?: string;
}

/**
 * Start the Agor daemon programmatically.
 *
 * Called by `agor daemon start` CLI command with a pre-loaded config,
 * or from main.ts with no args for direct execution.
 */
export async function startDaemon(options?: DaemonStartOptions): Promise<void> {
  // Initialize Handlebars helpers for template rendering
  registerHandlebarsHelpers();
  console.log('✅ Handlebars helpers registered');

  // Configure Git to fail fast instead of prompting for credentials
  process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.GIT_ASKPASS = 'echo';

  // Load config: CLI-provided > configPath > default loadConfig()
  const config: AgorConfig = options?.config
    ? options.config
    : options?.configPath
      ? await loadConfigFromFile(options.configPath)
      : await loadConfig();

  // Resolve service tier configuration (validate deps, auto-promote)
  const servicesConfig = resolveServicesConfig(config.services);
  logServicesConfig(servicesConfig);

  const svcTier = (group: string): ServiceTier =>
    getServiceTier(servicesConfig, group as ServiceGroupName);
  const svcEnabled = (group: string): boolean =>
    isServiceEnabled(servicesConfig, group as ServiceGroupName);

  // --------------------------------------------------------------------------
  // Auth configuration
  // --------------------------------------------------------------------------
  const allowAnonymous = config.daemon?.allowAnonymous === true;
  const authStrategies = allowAnonymous ? ['api-key', 'jwt', 'anonymous'] : ['api-key', 'jwt'];
  const requireAuth = authenticate({ strategies: authStrategies });

  const enforcePasswordChange = async (context: HookContext) => {
    const user = context.params?.user as User | undefined;
    if (!user) return context;

    let freshUser: User;
    try {
      freshUser = await context.app.service('users').get(user.user_id, { provider: undefined });
    } catch {
      return context;
    }
    if (!freshUser.must_change_password) return context;
    if (context.path === 'authentication' || context.path === 'authentication/refresh')
      return context;
    if (context.path === 'health') return context;
    if (context.path === 'users') {
      if (context.id === freshUser.user_id) {
        if (context.method === 'get') return context;
        if (context.method === 'patch') {
          const data = context.data as { password?: string } | undefined;
          if (data?.password) return context;
          throw new Forbidden('Password change required. Please update your password.', {
            code: 'PASSWORD_CHANGE_REQUIRED',
            user_id: freshUser.user_id,
          });
        }
      }
    }
    throw new Forbidden('Password change required. Please update your password.', {
      code: 'PASSWORD_CHANGE_REQUIRED',
      user_id: freshUser.user_id,
    });
  };

  const getReadAuthHooks = () => (allowAnonymous ? [] : [requireAuth]);

  // --------------------------------------------------------------------------
  // Security: block anonymous in public deployments
  // --------------------------------------------------------------------------
  const isPublicDeployment =
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT !== undefined ||
    process.env.RENDER !== undefined;

  if (isPublicDeployment && allowAnonymous) {
    console.error('');
    console.error('❌ SECURITY ERROR: Anonymous authentication is enabled in a public deployment');
    console.error('   This would allow unauthorized access to your Agor instance.');
    console.error('   Set daemon.allowAnonymous=false in config or unset it (defaults to false)');
    console.error('');
    process.exit(1);
  }

  // --------------------------------------------------------------------------
  // Ports, daemon URL, credentials
  // --------------------------------------------------------------------------
  const envPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;
  const DAEMON_PORT = envPort ?? config.daemon?.port ?? 3030;
  const DAEMON_HOST = config.daemon?.host ?? 'localhost';

  const envUiPort = process.env.UI_PORT ? Number.parseInt(process.env.UI_PORT, 10) : undefined;
  const UI_PORT = envUiPort || config.ui?.port || 5173;

  // Handle INSTANCE_LABEL env var override (for Docker deployments)
  if (process.env.INSTANCE_LABEL) {
    config.daemon = config.daemon || {};
    config.daemon.instanceLabel = process.env.INSTANCE_LABEL;
  }

  const daemonUrl = config.daemon?.public_url || `http://localhost:${DAEMON_PORT}`;
  configureDaemonUrl(daemonUrl);
  console.log(`[Executor] Daemon URL configured: ${daemonUrl}`);

  initializeAnthropicApiKey(config, process.env.ANTHROPIC_API_KEY);
  initializeAnthropicAuthToken(config, process.env.ANTHROPIC_AUTH_TOKEN);
  initializeAnthropicBaseUrl(config, process.env.ANTHROPIC_BASE_URL);

  // --------------------------------------------------------------------------
  // Create Feathers app + Express middleware
  // --------------------------------------------------------------------------
  const app = feathersExpress(feathers());

  // Configure how many reverse proxies we trust in front of the daemon.
  // Default 0 = ignore X-Forwarded-* entirely (so a client cannot spoof their
  // IP via headers). Operators with an explicit proxy chain set
  // `daemon.trust_proxy_hops` to the hop count.
  // The Number.isFinite guard is critical: `Number(Infinity) || 0` returns
  // Infinity (truthy), and Express interprets `trust proxy = Infinity` as
  // "trust everything" — which is the exact spoofing posture we are
  // defending against. Reject non-finite values (Infinity, NaN) to 0.
  const rawHops = Number(config.daemon?.trust_proxy_hops ?? 0);
  const trustProxyHops = Number.isFinite(rawHops) ? Math.max(0, Math.floor(rawHops)) : 0;
  app.set('trust proxy', trustProxyHops);
  if (trustProxyHops > 0) {
    console.log(
      `🔒 trust proxy = ${trustProxyHops} (honouring X-Forwarded-* from ${trustProxyHops} hop(s))`
    );
  } else {
    console.log('🔒 trust proxy = 0 (X-Forwarded-* headers ignored)');
  }

  const safeService = (path: string) => {
    try {
      return app.service(path);
    } catch {
      return undefined;
    }
  };

  // Resolve the `security.*` config block once and reuse it everywhere that
  // cares (CSP middleware, CORS middleware, /health response, CSP report
  // endpoint). The resolver handles:
  //   - merging defaults ⊕ extras ⊕ override for CSP
  //   - CORS mode/origins (plus legacy daemon.cors_* backcompat)
  //   - CORS_ORIGIN env var precedence
  //   - credentials:true + wildcard/reflect rejection at load time
  const resolvedSecurity: ResolvedSecurity = resolveSecurity(config, {
    daemonUrl,
    corsOriginEnv: process.env.CORS_ORIGIN,
    legacyCorsOrigins: config.daemon?.cors_origins,
    legacyAllowSandpack:
      config.daemon?.cors_allow_sandpack !== undefined
        ? config.daemon.cors_allow_sandpack
        : undefined,
  });

  // CORS
  const {
    origin: corsOrigin,
    credentialsAllowed,
    isWildcard,
    isAllowedOrigin,
    extraOptions: corsExtraOptions,
  } = buildCorsConfig({
    uiPort: UI_PORT,
    daemonPort: DAEMON_PORT,
    resolved: resolvedSecurity.cors,
  });

  // Refuse to boot when a hardened deployment is configured to reflect any
  // origin with credentials enabled. In dev/local mode we only warn loudly
  // and let the cors helper drop credentials so the daemon stays usable.
  // `execution.deployment_mode` is intentionally read defensively — the key
  // may not yet be defined in older configs.
  const deploymentMode = (config.execution as { deployment_mode?: string } | undefined)
    ?.deployment_mode;
  if (isWildcard) {
    const banner =
      '\n*** SECURITY WARNING: CORS is set to reflect ANY origin (CORS_ORIGIN=*).\n' +
      '    Credentials have been disabled to prevent credentialed cross-origin requests.\n' +
      '    Restrict CORS_ORIGIN before exposing this daemon to untrusted networks. ***\n';
    if (deploymentMode === 'solo' || deploymentMode === 'team') {
      console.error(banner);
      console.error(
        `❌ Refusing to start: deployment_mode=${deploymentMode} forbids wildcard CORS.`
      );
      process.exit(1);
    } else {
      console.error(banner);
    }
  }

  // Per-request middleware (runs BEFORE cors()):
  //   1. Echo Access-Control-Allow-Private-Network ONLY for explicit allow-list
  //      origins (never for Sandpack, never for unknown wildcard origins).
  //   2. Patch res.setHeader so that Access-Control-Allow-Credentials is
  //      suppressed on Sandpack-origin responses — INCLUDING preflights. The
  //      previous post-cors() removeHeader middleware never ran for OPTIONS,
  //      because cors() short-circuits the preflight chain via res.end().
  //      Patching setHeader catches headers cors() sets on its way to end().
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (
      typeof origin === 'string' &&
      req.headers['access-control-request-private-network'] === 'true' &&
      isAllowedOrigin(origin)
    ) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }

    if (typeof origin === 'string' && isSandpackOrigin(origin)) {
      const originalSetHeader = res.setHeader.bind(res);
      // biome-ignore lint/suspicious/noExplicitAny: setHeader has many overloads
      (res as any).setHeader = (name: string, value: any) => {
        if (typeof name === 'string' && name.toLowerCase() === 'access-control-allow-credentials') {
          return res;
        }
        return originalSetHeader(name, value);
      };
    }
    next();
  });

  app.use(cors({ origin: corsOrigin, credentials: credentialsAllowed, ...corsExtraOptions }));

  // Security headers (CSP, X-Frame-Options, nosniff, Referrer-Policy, HSTS).
  // Must run after CORS so preflights still get the Access-Control-* headers.
  app.use(securityHeaders({ csp: resolvedSecurity.csp }) as never);

  // CSP violation reporting endpoint. Only mounted when operators opt in via
  // `security.csp.report_uri`. Handler is deliberately minimal: accept POSTs
  // of either shape (`application/csp-report` legacy or
  // `application/reports+json` modern), log at warn level with pino, and
  // respond 204. Rate-limited to protect against report floods.
  const reportUri = resolvedSecurity.csp.reportUri;
  if (reportUri?.startsWith('/')) {
    const { default: rateLimit } = await import('express-rate-limit');
    const reportLimiter = rateLimit({
      windowMs: 60_000,
      limit: 120, // 2 reports/sec average per IP — tight but avoids total silence
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: 'Too many CSP reports',
    });
    app.use(
      reportUri,
      express.json({
        type: ['application/csp-report', 'application/reports+json', 'application/json'],
        limit: '16kb',
      }),
      reportLimiter as never,
      ((req: express.Request, res: express.Response) => {
        if (req.method !== 'POST') {
          res.status(405).end();
          return;
        }
        console.warn('[csp-report]', JSON.stringify(req.body));
        res.status(204).end();
      }) as never
    );
  }

  // HTTP proxies need raw bytes (no JSON/urlencoded reserialization) so the
  // configured upstream sees exactly what the artifact wrote. Mount raw-body
  // capture for `/proxies` BEFORE the global parsers below — once `req._body`
  // is set, downstream parsers skip the request. Only mounted when at least
  // one proxy is configured (matches the rest of the feature's "off by
  // default" posture).
  if (config.proxies && Object.keys(config.proxies).length > 0) {
    app.use('/proxies', express.raw({ type: '*/*', limit: '10mb' }));
  }

  // Default to a 10MB JSON body. The previous 10MB pre-hardening default was
  // unbounded enough to allow trivial memory-pressure DoS, and a 1MB ceiling
  // turned out to break legitimate flows (large prompts, /messages/bulk
  // batches, oversized template payloads). 10MB is the balance: tight enough
  // to bound a single attacker request, loose enough that real bulk-message
  // payloads pass without per-route overrides. Multipart uploads bypass this
  // limit (multer parses the body itself) and are capped separately.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // --------------------------------------------------------------------------
  // Static file serving (production only)
  // --------------------------------------------------------------------------
  const isProduction = process.env.NODE_ENV === 'production';
  const serveStaticFiles = servicesConfig.static_files !== 'off';
  if (isProduction && serveStaticFiles) {
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { existsSync } = await import('node:fs');

    const dirname =
      typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    const uiPath = path.resolve(dirname, '../ui');

    if (existsSync(uiPath)) {
      console.log(`📂 Serving UI from: ${uiPath}`);

      app.use(
        '/ui',
        expressStaticGzip(uiPath, {
          enableBrotli: false,
          orderPreference: ['gz'],
          serveStatic: { maxAge: '1y' },
        }) as never
      );
      app.use('/ui/*', ((_req: unknown, res: express.Response) => {
        res.sendFile(path.join(uiPath, 'index.html'));
      }) as never);
      app.use('/', ((req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (req.path === '/' && req.method === 'GET') {
          res.redirect('/ui/');
        } else {
          next();
        }
      }) as never);
    } else {
      console.warn(`⚠️  UI directory not found at ${uiPath} - UI will not be served`);
      console.warn(`   This is expected in development mode (UI runs on port ${UI_PORT})`);
    }
  }

  // Serve static assets (e.g., self-hosted Sandpack bundler) if available
  if (serveStaticFiles) {
    const pathMod = await import('node:path');
    const { fileURLToPath: toPath } = await import('node:url');
    const { existsSync: exists } = await import('node:fs');
    const dir =
      typeof __dirname !== 'undefined' ? __dirname : pathMod.dirname(toPath(import.meta.url));
    const staticPath = pathMod.resolve(dir, '../static');
    if (exists(staticPath)) {
      console.log(`📂 Serving static assets from: ${staticPath}`);
      app.use('/static', express.static(staticPath) as never);
    }
  }

  // OAuth callback middleware stub — handler is wired by registerServices()
  const appRecord = app as unknown as Record<string, unknown>;
  app.use('/mcp-servers/oauth-callback', ((
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const handler = appRecord.oauthCallbackHandler as
      | ((req: express.Request, res: express.Response) => void)
      | null;
    if (req.method === 'GET' && handler) {
      handler(req, res);
    } else {
      next();
    }
  }) as never);

  // Compress dynamic API responses (after static file serving)
  app.use(compression() as never);

  // --------------------------------------------------------------------------
  // REST, Socket.io, Swagger, Database
  // --------------------------------------------------------------------------
  app.configure(rest());

  // Generate or load JWT secret
  let jwtSecret = config.daemon?.jwtSecret;
  if (!jwtSecret) {
    const crypto = await import('node:crypto');
    jwtSecret = crypto.randomBytes(32).toString('hex');
    const { setConfigValue } = await import('@agor/core/config');
    await setConfigValue('daemon.jwtSecret', jwtSecret);
    console.log(
      `🔑 Generated and saved persistent JWT secret to config (length=${jwtSecret.length})`
    );
  } else {
    // SECURITY: never log any prefix/substring of the secret. Length only.
    console.log(`🔑 Loaded existing JWT secret from config (length=${jwtSecret.length})`);
  }

  const socketIOConfig = createSocketIOConfig(app, {
    corsOrigin,
    jwtSecret,
    allowAnonymous,
    credentialsAllowed,
    // Mirror the HTTP terminals service gate (register-hooks.ts) so the
    // `allow_web_terminal: false` kill-switch is enforced on the WebSocket
    // transport too. Without this the terminal:* relay events would still
    // accept traffic when the HTTP modal is disabled.
    webTerminalEnabled: config.execution?.allow_web_terminal !== false,
    // Build info for the version-sync banner. Emitted as the `server-info`
    // welcome event on every connect (and reconnect), so UI tabs can detect
    // FE/BE drift after a deploy without waiting for the next /health poll.
    buildInfo: DAEMON_BUILD_INFO,
  });
  app.configure(socketio(socketIOConfig.serverOptions, socketIOConfig.callback));
  configureChannels(app);
  configureSwagger(app, { version: DAEMON_VERSION, port: DAEMON_PORT });

  const { db } = await initializeDatabase(DB_PATH);

  // --------------------------------------------------------------------------
  // RBAC flags
  // --------------------------------------------------------------------------
  const worktreeRbacEnabled = config.execution?.worktree_rbac === true;
  const allowSuperadmin = config.execution?.allow_superadmin === true;
  const superadminOpts = { allowSuperadmin };

  // --------------------------------------------------------------------------
  // Phase 1: Register services
  // --------------------------------------------------------------------------
  const services = await registerServices({
    db,
    app,
    config,
    svcEnabled,
    jwtSecret,
    daemonUrl,
    isProduction,
    DAEMON_PORT,
    UI_PORT,
    worktreeRbacEnabled,
    allowSuperadmin,
    requireAuth,
  });

  // --------------------------------------------------------------------------
  // Phase 2: Register hooks
  // --------------------------------------------------------------------------
  registerHooks({
    db,
    app,
    config,
    svcEnabled,
    jwtSecret,
    worktreeRbacEnabled,
    allowAnonymous,
    requireAuth,
    getReadAuthHooks,
    superadminOpts,
    sessionsService: services.sessionsService,
    messagesService: services.messagesService,
    boardsService: services.boardsService,
    worktreeRepository: services.worktreeRepository,
    usersRepository: services.usersRepository,
    sessionsRepository: services.sessionsRepository,
  });

  // --------------------------------------------------------------------------
  // Phase 3: Register routes (auth, REST, tier hooks, error handler)
  // --------------------------------------------------------------------------
  await registerRoutes({
    db,
    app,
    config,
    svcEnabled,
    svcTier,
    jwtSecret,
    worktreeRbacEnabled,
    allowAnonymous,
    requireAuth,
    enforcePasswordChange,
    superadminOpts,
    DB_PATH,
    DAEMON_PORT,
    DAEMON_VERSION,
    DAEMON_BUILD_INFO,
    servicesConfig,
    resolvedSecurity,
    sessionsService: services.sessionsService,
    messagesService: services.messagesService,
    boardsService: services.boardsService,
    worktreeRepository: services.worktreeRepository,
    usersRepository: services.usersRepository,
    sessionsRepository: services.sessionsRepository,
    sessionMCPServersService: services.sessionMCPServersService,
    sessionEnvSelectionsService: services.sessionEnvSelectionsService,
    terminalsService: services.terminalsService,
  });

  // --------------------------------------------------------------------------
  // Phase 4: Startup (orphan cleanup, health, scheduler, listen, shutdown)
  // --------------------------------------------------------------------------
  await startup({
    app,
    db,
    config,
    DAEMON_PORT,
    DAEMON_HOST,
    svcEnabled,
    safeService,
    getSocketServer: socketIOConfig.getSocketServer,
    sessionsService: services.sessionsService,
    terminalsService: services.terminalsService,
  });
}
