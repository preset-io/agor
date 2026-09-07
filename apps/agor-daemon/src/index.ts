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
import { homedir, platform } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// Patch console methods to respect LOG_LEVEL env var
import { configureAnalyticsLogger } from '@agor/core/analytics';
import {
  configureOpenSourceTelemetryLogger,
  loadOpenSourceTelemetryAgorVersion,
  openSourceTelemetryLogger,
} from '@agor/core/telemetry';
import { patchConsole } from '@agor/core/utils/logger';
import { extractDbFilePath } from '@agor/core/utils/path';
import { deriveLoopbackReachableOrigin, UI_MOUNT_PATH } from '@agor/core/utils/url';

patchConsole();

import {
  assertConfiguredAgenticToolsReady,
  getAgenticToolsRoot,
} from '@agor/core/agentic-integrations';
import type { AgorConfig, ResolvedSecurity } from '@agor/core/config';
import {
  assertValidEffectiveExecutionConfig,
  assertValidEffectiveIdentityConfig,
  assertValidRawConfig,
  getConfigPath,
  loadConfig,
  loadConfigFromFile,
  renderGitConfigParametersForLog,
  requireDeploymentId,
  resolveDataHomeFromConfig,
  resolveDeploymentConfig,
  resolveEffectiveConfig,
  resolveGitConfigParameters,
  resolveIdentityAuthority,
  resolveMultiTenancyConfig,
  resolveSecurity,
  resolveValidExternalLaunchProvider,
} from '@agor/core/config';
import { generateId, resolveDatabaseUrl } from '@agor/core/db';
import {
  authenticate,
  Forbidden,
  feathers,
  feathersExpress,
  rest,
  socketio,
} from '@agor/core/feathers';
import { buildGitConfigParameters } from '@agor/core/git/pure';
import { registerHandlebarsHelpers } from '@agor/core/templates/handlebars-helpers';
import type { HookContext, User } from '@agor/core/types';
import cors from 'cors';
import express from 'express';
import expressStaticGzip from 'express-static-gzip';
import { createRequireAuthHook } from './auth/require-auth.js';
import { reconcileTrackedExecutorGauge } from './executor-tracking.js';
import { createHttpMetricsMiddleware } from './metrics/http.js';
import { createDaemonMetrics, NOOP_METRICS, resolveMetricsWorkIdentity } from './metrics/index.js';
import { type OwnStartupMetrics, runWithStartupMetricsOwner } from './metrics/startup-ownership.js';
import { RedisRealtimeRuntime } from './realtime/redis-realtime.js';
import { LOCAL_AUTHORIZATION_INVALIDATION_EVENT } from './realtime/routing.js';
import { registerHooks } from './register-hooks.js';
import { registerRoutes } from './register-routes.js';
import { registerServices } from './register-services.js';
import { createMCPOAuthCallbackRoute } from './services/mcp-oauth-callback-route.js';
import { loadBuildInfo } from './setup/build-info.js';
import { createDynamicCompressionMiddleware } from './setup/compression.js';
import { buildCorsConfig, isSandpackOrigin } from './setup/cors.js';
import { initializeDatabase } from './setup/database.js';
import { initializeDistributedWorkIdentity } from './setup/distributed-work-identity.js';
import { warnDeprecatedConfig } from './setup/first-run-admin.js';
import { resolveMasterSecretIntoEnv } from './setup/master-secret.js';
import { securityHeaders } from './setup/security-headers.js';
import { configureChannels, createSocketIOConfig } from './setup/socketio.js';
import { setBundledUiFallbackHeaders, setBundledUiStaticHeaders } from './setup/static-assets.js';
import { configureSwagger } from './setup/swagger.js';
import { loadDaemonVersion } from './setup/version.js';
import { startup } from './startup.js';
import { resolveWebTerminalCapability } from './terminal-capability.js';
import { configureResolvedConfigSlice } from './utils/build-resolved-config-slice.js';
import { deepFreezeClone } from './utils/deep-freeze.js';
import { ensureOpenSourceTelemetryEnvEnabledConfig } from './utils/open-source-telemetry-config.js';
import { shouldEmitOpenSourceTelemetryDaemonActive } from './utils/open-source-telemetry-heartbeat.js';
import { startOpenSourceTelemetryUsageSummaryInterval } from './utils/open-source-telemetry-usage.js';
import { assertRealtimePublishPolicyCoverage } from './utils/realtime-publish-policy.js';
import { resolveSandboxProtectedDataRoots } from './utils/sandbox-context.js';
import { configureDaemonUrl, configureExecutor } from './utils/spawn-executor.js';
import { configureUploadStagingStoreFromConfig } from './utils/upload-staging.js';
import { registerAllWidgets } from './widgets/index.js';

// Load daemon version at startup
const DAEMON_VERSION = await loadDaemonVersion(import.meta.url);
const AGOR_VERSION = await loadOpenSourceTelemetryAgorVersion(DAEMON_VERSION, import.meta.url);

// Resolve build SHA (env > .build-info file > git > 'dev'). UI tabs capture
// this on first connect and prompt a refresh if a later handshake disagrees.
const DAEMON_BUILD_INFO = loadBuildInfo(import.meta.url);
console.log(
  `🔖 Build: sha=${DAEMON_BUILD_INFO.sha} ` +
    `builtAt=${DAEMON_BUILD_INFO.builtAt ?? 'unknown'} ` +
    `(source=${DAEMON_BUILD_INFO.source})`
);

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
  await runWithStartupMetricsOwner((ownMetrics) =>
    startDaemonWithOwnedMetrics(options, ownMetrics)
  );
}

async function startDaemonWithOwnedMetrics(
  options: DaemonStartOptions | undefined,
  ownMetrics: OwnStartupMetrics
): Promise<void> {
  // Initialize Handlebars helpers for template rendering
  registerHandlebarsHelpers();
  console.log('✅ Handlebars helpers registered');

  // Populate the widget registry. Each concrete widget type (`env_vars`,
  // future `confirmation`, `oauth`, ...) lives in its own subdir under
  // `./widgets/` and side-effect-registers via this central call. The
  // registry is consulted by `POST /widgets/:id/{submit,dismiss}` and by
  // the `agor_widgets_request_*` MCP tools.
  registerAllWidgets();
  console.log('✅ Widget registry populated');

  // Configure Git to fail fast instead of prompting for credentials
  process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.GIT_ASKPASS = 'echo';

  // Load config: CLI-provided > configPath > default loadConfig()
  let config: AgorConfig = options?.config
    ? options.config
    : options?.configPath
      ? await loadConfigFromFile(options.configPath)
      : await loadConfig();

  // Programmatic startup must cross the same untrusted config boundary as
  // YAML before environment projection reads nested scalar values.
  assertValidRawConfig(config);

  // Deployment environment overrides are resolved in memory. Container and
  // Kubernetes entrypoints must never materialize them back into config.yaml.
  config = resolveEffectiveConfig(config);
  const deploymentId = requireDeploymentId(config);
  assertValidEffectiveExecutionConfig(config);
  const externalLaunchProvider = resolveValidExternalLaunchProvider(config);
  assertValidEffectiveIdentityConfig(config);
  const databaseUrl = resolveDatabaseUrl({ config, env: process.env });

  // Deployment package availability is instance-global. Validate it before
  // database or tenant initialization so no tenant can expand the daemon's
  // installed-code surface and a broken upgrade never starts listening.
  const resolvedAgenticTools = await assertConfiguredAgenticToolsReady(config);
  if (resolvedAgenticTools) {
    // In-memory projection only: config.yaml remains immutable while every
    // service consumes the same deployment policy resolved at startup.
    config = {
      ...config,
      agentic_tools: { ...config.agentic_tools, installed: [...resolvedAgenticTools] },
    };
  }

  // HA is an explicit, validated topology boundary. REDIS_URL alone never
  // changes standalone behavior. Resolve this after immutable environment
  // projection so every startup consumer observes one effective snapshot.
  const deployment = resolveDeploymentConfig(config, process.env, databaseUrl);
  console.log(`🌐 Deployment mode: ${deployment.mode}`);

  const multiTenancy = resolveMultiTenancyConfig(config);
  console.log(
    `🏢 Multi-tenancy: mode=${multiTenancy.mode} tenant=${multiTenancy.mode === 'static' ? multiTenancy.static_tenant_id : 'auth-resolved'}`
  );

  // Set GIT_CONFIG_PARAMETERS before any child-process spawn so every git
  // invocation under Agor's control inherits it. See @agor/core/config
  // (security-resolver) for the defaults + resolver semantics.
  const resolvedGitParams = resolveGitConfigParameters(config.security?.git_config_parameters);
  const gitConfigParams = buildGitConfigParameters(resolvedGitParams);
  if (gitConfigParams.length > 0) {
    process.env.GIT_CONFIG_PARAMETERS = gitConfigParams;
    console.log(
      `🔒 GIT_CONFIG_PARAMETERS hardened: ${renderGitConfigParametersForLog(resolvedGitParams)}`
    );
  } else {
    // override: [] in config — Agor defaults disabled; any inherited env var preserved.
    console.log(
      '🔒 Agor git hardening disabled (override: []); inherited GIT_CONFIG_PARAMETERS preserved'
    );
  }

  // Configure analytics after process-wide git hardening is installed. Module
  // plugins are optional dynamic imports and must never prevent daemon startup.
  await configureAnalyticsLogger(config);
  const envTelemetryConfig = ensureOpenSourceTelemetryEnvEnabledConfig(config);
  if (envTelemetryConfig.changed) config = envTelemetryConfig.config;
  // Detach the snapshot before freezing so callers that supplied
  // DaemonStartOptions.config retain ownership of their object graph.
  const effectiveConfig = deepFreezeClone(config);
  configureResolvedConfigSlice(effectiveConfig);
  configureOpenSourceTelemetryLogger(effectiveConfig);
  if (effectiveConfig.telemetry?.enabled === undefined) {
    console.warn(
      'ℹ  Community telemetry is not configured; no telemetry will be sent. ' +
        'Set AGOR_TELEMETRY=1/0 or edit telemetry.enabled in operator-managed config.yaml.'
    );
  }

  // Surface a clear migration note for accepted-but-ignored upgrade keys.
  warnDeprecatedConfig(effectiveConfig);

  // --------------------------------------------------------------------------
  // Auth configuration
  // --------------------------------------------------------------------------
  const authenticatedHook = authenticate({ strategies: ['api-key', 'jwt'] });
  const requireAuthOnly = createRequireAuthHook(authenticatedHook, multiTenancy);

  const enforcePasswordChange = async (context: HookContext) => {
    const user = context.params?.user as User | undefined;
    if (!user) return context;

    let freshUser: User;
    try {
      freshUser = await context.app.service('users').get(user.user_id, { provider: undefined });
    } catch {
      return context;
    }
    if (
      !freshUser.must_change_password ||
      !resolveIdentityAuthority(effectiveConfig).capabilities.users.passwordWrite
    ) {
      return context;
    }
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

  /**
   * `enforcePasswordChange` is also registered as a global app hook, but Feathers
   * runs app-level hooks *before* service-level ones — so over REST it fired while
   * `params.user` was still unset by the service's own `requireAuth`, hit its
   * `if (!user) return context` guard, and silently passed the request through. A
   * user flagged for a password change could do anything the CLI offered. On
   * Socket.IO the connection already carries `params.user`, which is why the gate
   * worked there and the gap only ever showed up over REST.
   *
   * Running it here, immediately after authentication resolves, means the check
   * happens once at the auth chokepoint with the user actually populated.
   */
  const requireAuth = async (context: HookContext): Promise<HookContext> =>
    enforcePasswordChange(await requireAuthOnly(context));

  // --------------------------------------------------------------------------
  // Ports, daemon URL, credentials
  // --------------------------------------------------------------------------
  const envPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;
  const DAEMON_PORT = envPort ?? effectiveConfig.daemon?.port ?? 3030;
  const DAEMON_HOST = process.env.DAEMON_HOST ?? effectiveConfig.daemon?.host ?? 'localhost';

  const envUiPort = process.env.UI_PORT ? Number.parseInt(process.env.UI_PORT, 10) : undefined;
  const UI_PORT = envUiPort || effectiveConfig.ui?.port || 5173;

  const daemonUrl = effectiveConfig.daemon?.public_url || `http://localhost:${DAEMON_PORT}`;
  configureDaemonUrl(daemonUrl);

  const dataHome = resolveDataHomeFromConfig(effectiveConfig);
  if (effectiveConfig.execution?.sandbox?.enabled === true && !isAbsolute(dataHome)) {
    throw new Error(
      `execution.sandbox.enabled requires an absolute effective paths.data_home; received ${dataHome}`
    );
  }
  const configuredPath = resolve(
    options?.configPath ?? process.env.AGOR_CONFIG_PATH ?? getConfigPath()
  );
  const localDatabasePath =
    databaseUrl.startsWith('file:') || isAbsolute(databaseUrl) || databaseUrl.startsWith('~/')
      ? extractDbFilePath(databaseUrl)
      : undefined;

  // Wire the configured executor command template and delegated home key so the
  // ~10 spawnExecutorFireAndForget() call sites pick them up without needing
  // their own config-threading code. Local-subprocess remains the default
  // when execution.executor_command_template is unset (no behavior change
  // for existing deployments).
  configureExecutor(effectiveConfig.execution, {
    requireTenantContext: multiTenancy.mode === 'required_from_auth',
    localResponseOriginUrl: deriveLoopbackReachableOrigin(DAEMON_HOST, DAEMON_PORT),
    sandboxRuntimePaths: {
      homeDir: homedir(),
      dataHome,
      protectedDataRoots: resolveSandboxProtectedDataRoots(effectiveConfig),
      worktreesRoot: join(dataHome, 'worktrees'),
      agenticToolsPath: getAgenticToolsRoot(),
      agorConfigPath: configuredPath,
      agorDbPath: localDatabasePath,
    },
  });

  // --------------------------------------------------------------------------
  // Create Feathers app + Express middleware
  // --------------------------------------------------------------------------
  const app = feathersExpress(feathers());
  // One application-owned identity spans every background worker in this
  // daemon process. A dedicated YAML deployment.instance_id may be added with
  // the HA config contract later; unrelated auth configuration is not reused.
  const distributedWorkIdentity = initializeDistributedWorkIdentity(app, {
    environment: {
      AGOR_DAEMON_INSTANCE_ID: process.env.AGOR_DAEMON_INSTANCE_ID,
      HOSTNAME: process.env.HOSTNAME,
    },
    generateBootId: generateId,
  });
  const explicitMetricsInstanceId = process.env.AGOR_DAEMON_INSTANCE_ID?.trim();
  const metricsWorkIdentity = resolveMetricsWorkIdentity(
    deployment.mode,
    distributedWorkIdentity,
    explicitMetricsInstanceId
  );
  const unsafeHaMetricsIdentity =
    effectiveConfig.metrics?.statsd?.enabled === true && !metricsWorkIdentity;
  const metrics = unsafeHaMetricsIdentity
    ? NOOP_METRICS
    : createDaemonMetrics(effectiveConfig.metrics?.statsd, {
        workIdentity: metricsWorkIdentity ?? distributedWorkIdentity,
        deploymentMode: deployment.mode,
        deploymentId,
      });
  ownMetrics(metrics);
  app.set('metrics', metrics);
  reconcileTrackedExecutorGauge(app);
  if (unsafeHaMetricsIdentity) {
    console.warn(
      '[metrics.statsd] Metrics disabled: HA requires a stable, unique AGOR_DAEMON_INSTANCE_ID per replica (letters, digits, dot, underscore, or hyphen; max 100 characters) so gauges cannot collapse into a last-writer-wins series.'
    );
  }
  if (metrics.enabled) {
    console.log(
      `📈 DogStatsD metrics enabled (${effectiveConfig.metrics?.statsd?.host}:${effectiveConfig.metrics?.statsd?.port}, prefix=${effectiveConfig.metrics?.statsd?.prefix})`
    );
  }
  const realtimeRuntime =
    deployment.mode === 'ha'
      ? new RedisRealtimeRuntime(deployment.redis, distributedWorkIdentity, {
          onUnavailable: () => {
            // Redis is the required HA invalidation/fanout plane. Clear every
            // local authorization cache and terminal capability before the
            // runtime closes transports; reconnects are admitted only after
            // both Redis clients return to ready.
            app.emit(LOCAL_AUTHORIZATION_INVALIDATION_EVENT, {});
          },
        })
      : undefined;

  // Configure how many reverse proxies we trust in front of the daemon.
  // Default 0 = ignore X-Forwarded-* entirely (so a client cannot spoof their
  // IP via headers). Operators with an explicit proxy chain set
  // `daemon.trust_proxy_hops` to the hop count.
  // The Number.isFinite guard is critical: `Number(Infinity) || 0` returns
  // Infinity (truthy), and Express interprets `trust proxy = Infinity` as
  // "trust everything" — which is the exact spoofing posture we are
  // defending against. Reject non-finite values (Infinity, NaN) to 0.
  const rawHops = Number(effectiveConfig.daemon?.trust_proxy_hops ?? 0);
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
  const resolvedSecurity: ResolvedSecurity = resolveSecurity(effectiveConfig, {
    daemonUrl,
    corsOriginEnv: process.env.CORS_ORIGIN,
    legacyCorsOrigins: effectiveConfig.daemon?.cors_origins,
    legacyAllowSandpack:
      effectiveConfig.daemon?.cors_allow_sandpack !== undefined
        ? effectiveConfig.daemon.cors_allow_sandpack
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
  const deploymentMode = (effectiveConfig.execution as { deployment_mode?: string } | undefined)
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

  // Start API transport timing before body parsing so malformed/oversized
  // payload responses are visible too. Static/UI and the OAuth callback are
  // excluded by code-defined prefixes rather than becoming route tags.
  app.use(
    createHttpMetricsMiddleware(app, metrics, {
      excludedPathPrefixes: [UI_MOUNT_PATH, '/static', '/mcp-servers/oauth-callback'],
    }) as never
  );

  // Default to a 10MB JSON body. The previous 10MB pre-hardening default was
  // unbounded enough to allow trivial memory-pressure DoS, and a 1MB ceiling
  // turned out to break legitimate flows (large prompts and oversized
  // template payloads). 10MB is the balance: tight enough to bound a single
  // attacker request while allowing real prompts and templates. Multipart uploads bypass this
  // limit (multer parses the body itself) and are capped separately.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // --------------------------------------------------------------------------
  // Static file serving — serve the bundled UI when it exists alongside
  // the daemon (i.e., installed-package layout: dist/daemon + dist/ui).
  // Previously gated on NODE_ENV=production, which made the UI 404 in
  // foreground mode (where NODE_ENV is unset) — see issue #1150. The actual
  // signal is "do we have a built UI bundle to serve?", which existsSync
  // already answers correctly for both dev (no, vite serves on its own port)
  // and installed (yes, it sits at ../ui).
  // --------------------------------------------------------------------------
  let bundledUiAvailable = false;
  {
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { existsSync } = await import('node:fs');

    const dirname =
      typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    const uiPath = path.resolve(dirname, '../ui');

    if (existsSync(uiPath)) {
      bundledUiAvailable = true;
      console.log(`📂 Serving UI from: ${uiPath}`);

      app.use(
        UI_MOUNT_PATH,
        expressStaticGzip(uiPath, {
          enableBrotli: false,
          orderPreference: ['gz'],
          serveStatic: {
            etag: true,
            setHeaders: setBundledUiStaticHeaders,
          },
        }) as never
      );
      app.use(`${UI_MOUNT_PATH}/*`, ((_req: unknown, res: express.Response) => {
        setBundledUiFallbackHeaders(res);
        res.sendFile(path.join(uiPath, 'index.html'));
      }) as never);
      app.use('/', ((req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (req.path === '/' && req.method === 'GET') {
          res.redirect(`${UI_MOUNT_PATH}/`);
        } else {
          next();
        }
      }) as never);
    } else {
      console.warn(`⚠️  UI bundle not found at ${uiPath} - UI will not be served`);
      console.warn(`   This is expected in development mode (UI runs on port ${UI_PORT})`);
    }
  }

  // Serve static assets (e.g., self-hosted Sandpack bundler) if available
  {
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

  // Browser OAuth callbacks must be mounted before Feathers REST. The handler
  // itself is installed after service registration below.
  const mcpOAuthCallbackRoute = createMCPOAuthCallbackRoute();
  app.use('/mcp-servers/oauth-callback', mcpOAuthCallbackRoute.middleware as never);

  // Compress dynamic REST/API responses after static file serving. The filter
  // deliberately skips streaming/event-stream routes.
  app.use(createDynamicCompressionMiddleware() as never);

  // --------------------------------------------------------------------------
  // REST, Socket.io, Swagger, Database
  // --------------------------------------------------------------------------
  app.configure(rest());

  // JWT secret: env > existing config value > fail-fast with operator-actionable remediation.
  // and context/explorations/daemon-fs-decoupling.md §1.5 (H3).
  //
  // Failing-fast is critical: a fresh JWT secret on every restart invalidates
  // every issued token, which silently breaks every active session.
  const { resolvePersistedSecret } = await import('./setup/persisted-secret.js');
  const jwtResolution = await resolvePersistedSecret({
    name: 'JWT secret',
    envVar: 'AGOR_JWT_SECRET',
    existing: effectiveConfig.daemon?.jwtSecret,
    configKey: 'daemon.jwtSecret',
  });
  const jwtSecret = jwtResolution.value;
  // SECURITY: never log any prefix/substring of the secret. Length only.
  switch (jwtResolution.source) {
    case 'env':
      console.log(`🔑 Loaded JWT secret from AGOR_JWT_SECRET env var (length=${jwtSecret.length})`);
      break;
    case 'config':
      console.log(`🔑 Loaded JWT secret from config (length=${jwtSecret.length})`);
      break;
  }

  // AGOR_MASTER_SECRET: resolve BEFORE Phase 1 (registerServices). Several
  // services — notably MCPOAuthPendingFlowAuthority on the PostgreSQL path —
  // are constructed eagerly during registration and read the secret off
  // process.env in their constructor. Resolving it here (rather than later in
  // startup()) is what lets deployments that keep the secret in config.yaml
  // (daemon.masterSecret), not an env var, boot on Postgres.
  const masterSecretSource = await resolveMasterSecretIntoEnv(effectiveConfig);
  console.log(
    masterSecretSource === 'env'
      ? '🔐 API key encryption enabled (AGOR_MASTER_SECRET set)'
      : '🔐 Using saved AGOR_MASTER_SECRET from config'
  );

  // HA is unavailable without Redis. Establish both adapter clients before
  // constructing Socket.IO or accepting any HTTP traffic.
  await realtimeRuntime?.connect();

  const socketIOConfig = createSocketIOConfig(app, {
    corsOrigin,
    credentialsAllowed,
    // Mirror the HTTP terminals service gate (register-hooks.ts) so the
    // `allow_web_terminal: false` kill-switch is enforced on the WebSocket
    // transport too. Without this the terminal:* relay events would still
    // accept traffic when the HTTP modal is disabled.
    webTerminalEnabled: resolveWebTerminalCapability({
      config: effectiveConfig,
      deployment,
    }).enabled,
    // Build info for the version-sync banner. Emitted as the `server-info`
    // welcome event on every connect (and reconnect), so UI tabs can detect
    // FE/BE drift after a deploy without waiting for the next /health poll.
    buildInfo: DAEMON_BUILD_INFO,
    workIdentity: distributedWorkIdentity,
    multiTenancy,
    ...(realtimeRuntime
      ? { adapter: realtimeRuntime.adapter, onServerCreated: (io) => realtimeRuntime.attach(io) }
      : {}),
  });
  app.configure(socketio(socketIOConfig.serverOptions, socketIOConfig.callback));
  configureChannels(app);
  configureSwagger(app, { version: DAEMON_VERSION, port: DAEMON_PORT });

  const { db } = await initializeDatabase(databaseUrl, {
    tenantId: multiTenancy.mode === 'static' ? multiTenancy.static_tenant_id : undefined,
    skipFirstRunAdminBootstrap:
      !resolveIdentityAuthority(effectiveConfig).capabilities.users.create,
    // The URL may come from DATABASE_URL, but operators still need to size the
    // per-replica pool from config.yaml. Keep this deliberately limited to max:
    // the public idleTimeout setting is documented in milliseconds while the
    // postgres.js client boundary uses seconds, and `min` is not implemented.
    pool: effectiveConfig.database?.postgresql?.pool?.max
      ? { max: effectiveConfig.database.postgresql.pool.max }
      : undefined,
    traceServices: effectiveConfig.metrics?.apm?.trace_services ?? 'off',
  });
  configureUploadStagingStoreFromConfig(effectiveConfig, undefined, db);

  // --------------------------------------------------------------------------
  // Authorization settings
  // --------------------------------------------------------------------------
  const allowSuperadmin = effectiveConfig.execution?.allow_superadmin === true;
  const superadminOpts = { allowSuperadmin };

  // Stash the shared Drizzle handle on the Feathers app so lifecycle
  // utilities that are not constructed with a database argument can resolve
  // it via `getDb(app)`. Services using constructor injection are unaffected.
  app.set('database', db);
  app.set('config', effectiveConfig);

  if (openSourceTelemetryLogger.isEnabled()) {
    const startupTelemetryProperties = {
      agor_version: AGOR_VERSION,
      deployment_kind: process.env.KUBERNETES_SERVICE_HOST
        ? 'k8s'
        : process.env.container || process.env.AGOR_DOCKER
          ? 'docker'
          : 'local',
      db_backend: process.env.AGOR_DB_DIALECT === 'postgresql' ? 'postgresql' : 'sqlite',
      os_family: platform(),
      node_major: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10),
      branch_rbac: true,
      unix_user_mode: effectiveConfig.execution?.unix_user_mode ?? 'simple',
    };

    openSourceTelemetryLogger.track({
      event: 'daemon.start',
      properties: startupTelemetryProperties,
    });

    const daemonActive = shouldEmitOpenSourceTelemetryDaemonActive(effectiveConfig);
    if (daemonActive.shouldEmit) {
      openSourceTelemetryLogger.track({
        event: 'daemon.active',
        properties: {
          ...startupTelemetryProperties,
          day: daemonActive.day,
        },
      });
    }

    if (
      effectiveConfig.telemetry?.last_reported_version &&
      effectiveConfig.telemetry.last_reported_version !== AGOR_VERSION
    ) {
      openSourceTelemetryLogger.track({
        event: 'daemon.upgraded',
        properties: {
          from_version: effectiveConfig.telemetry.last_reported_version,
          to_version: AGOR_VERSION,
        },
      });
    }
    startOpenSourceTelemetryUsageSummaryInterval(db, effectiveConfig, {
      tenantId: multiTenancy.static_tenant_id,
    });
  }

  // --------------------------------------------------------------------------
  // Phase 1: Register services
  // --------------------------------------------------------------------------
  const services = await registerServices({
    db,
    app,
    config: effectiveConfig,
    jwtSecret,
    daemonUrl,
    bundledUiAvailable,
    DAEMON_PORT,
    UI_PORT,
    allowSuperadmin,
    requireAuth,
    deployment,
  });
  mcpOAuthCallbackRoute.setHandler(services.oauthCallbackHandler);

  // --------------------------------------------------------------------------
  // Phase 2: Register hooks
  // --------------------------------------------------------------------------
  registerHooks({
    db,
    app,
    config: effectiveConfig,
    jwtSecret,
    requireAuth,
    superadminOpts,
    sessionsService: services.sessionsService,
    messagesService: services.messagesService,
    boardsService: services.boardsService,
    branchRepository: services.branchRepository,
    usersRepository: services.usersRepository,
    sessionsRepository: services.sessionsRepository,
    realtimeRelay: realtimeRuntime,
    deployment,
  });

  // --------------------------------------------------------------------------
  // Phase 3: Register routes (auth, REST, tier hooks, error handler)
  // --------------------------------------------------------------------------
  await registerRoutes({
    db,
    app,
    config: effectiveConfig,
    externalLaunchProvider,
    jwtSecret,
    requireAuth,
    enforcePasswordChange,
    superadminOpts,
    DB_PATH: databaseUrl,
    DAEMON_PORT,
    DAEMON_VERSION,
    AGOR_VERSION,
    DAEMON_BUILD_INFO,
    resolvedSecurity,
    realtimeRuntime,
    distributedWorkIdentity,
    deployment,
    sessionsService: services.sessionsService,
    boardsService: services.boardsService,
    branchRepository: services.branchRepository,
    usersRepository: services.usersRepository,
    sessionsRepository: services.sessionsRepository,
    sessionMCPServersService: services.sessionMCPServersService,
    sessionEnvSelectionsService: services.sessionEnvSelectionsService,
    terminalsService: services.terminalsService,
  });

  // --------------------------------------------------------------------------
  // Phase 3.5: Every registered service must have declared its realtime
  // audience. Undeclared services publish to nobody, which is the safe failure
  // but an invisible one — so refuse to boot rather than let realtime for a new
  // service quietly do nothing. Deterministic: it reads the registration table,
  // not request data.
  // --------------------------------------------------------------------------
  assertRealtimePublishPolicyCoverage(app);

  // --------------------------------------------------------------------------
  // Phase 4: Startup (orphan cleanup, health, scheduler, listen, shutdown)
  // --------------------------------------------------------------------------
  await startup({
    app,
    db,
    config: effectiveConfig,
    DAEMON_PORT,
    DAEMON_HOST,
    safeService,
    getSocketServer: socketIOConfig.getSocketServer,
    sessionsService: services.sessionsService,
    terminalsService: services.terminalsService,
    distributedWorkIdentity,
    // PostgreSQL leases/claims and executor-token authority make the merged
    // runtime workers replica-independent. Agor-managed permission callbacks
    // use the transient task-private realtime control path; unsupported
    // provider-native confirmation modes remain separately fail-closed.
    taskRuntimePolicy: deployment.mode === 'ha' ? 'shared_postgres' : 'standalone',
    environmentHealthMonitorPolicy: deployment.mode === 'ha' ? 'shared_postgres' : 'standalone',
    environmentHealthMonitorSettings:
      deployment.mode === 'ha' ? deployment.environmentHealthMonitor : undefined,
    realtimeRuntime,
  });
}
