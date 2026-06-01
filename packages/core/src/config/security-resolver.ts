/**
 * Security config resolver.
 *
 * Takes the raw `security` block from `~/.agor/config.yaml` and produces a
 * resolved shape the daemon can plug into `securityHeaders()` and `cors()`.
 *
 * The two-tier CSP model:
 *   - built-in defaults (hardcoded, make bundled features work)
 *   - `extras`: append to defaults (95% of operators)
 *   - `override`: replace a directive wholesale (escape hatch)
 *
 * Validation is done here (not in `config-manager`) so that the daemon can
 * surface clear, actionable errors at startup when config is malformed —
 * rather than emitting a subtly-broken header and failing at request time.
 */

import type {
  AgorConfig,
  AgorCorsMode,
  AgorCspDirectives,
  AgorGitConfigParametersSettings,
  AgorSecuritySettings,
} from './types';

export type { AgorGitConfigParametersSettings } from './types';

/**
 * Known CSP directive names (lowercase, hyphenated). Used to validate config
 * keys and surface typos as friendly errors. Covers Level 2 + Level 3 widely
 * supported directives; we deliberately DON'T include legacy aliases.
 */
const KNOWN_CSP_DIRECTIVES: ReadonlySet<string> = new Set([
  'default-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'style-src',
  'style-src-elem',
  'style-src-attr',
  'img-src',
  'font-src',
  'connect-src',
  'media-src',
  'object-src',
  'child-src',
  'frame-src',
  'worker-src',
  'manifest-src',
  'prefetch-src',
  'frame-ancestors',
  'form-action',
  'base-uri',
  'sandbox',
  'upgrade-insecure-requests',
  'block-all-mixed-content',
  'require-trusted-types-for',
  'trusted-types',
  'report-uri',
  'report-to',
]);

/**
 * Origins a browser is allowed to embed Sandpack iframes/workers from.
 *
 * The hosted CodeSandbox bundler iframes are served from `*.codesandbox.io`.
 * Web workers in those iframes are spawned from `blob:` URLs.
 *
 * Keeping this exported so tests can assert on the exact string and the
 * daemon can reuse it for its CORS allow-list (the two need to stay in sync
 * or sandpack breaks in subtle ways — iframe loads but posts cross-origin
 * requests the daemon rejects).
 */
export const SANDPACK_CSP_FRAME_SRC = 'https://*.codesandbox.io';
export const SANDPACK_CSP_WORKER_SRC = 'blob:';

/**
 * Built-in CSP defaults.
 *
 * These are designed to make every *bundled* Agor feature work out of the
 * box — notably Sandpack-backed artifacts (`frame-src`, `worker-src`) and
 * the FeathersJS socket.io transport (`connect-src ws:/wss:`).
 *
 * `connect-src` is extended at resolve-time with the daemon's own URL and
 * any caller-supplied extras.
 */
function buildDefaultDirectives(opts: {
  daemonUrl?: string;
  extraConnectSrc?: string[];
  allowSandpack: boolean;
}): AgorCspDirectives {
  const connectSrc = ["'self'", 'ws:', 'wss:'];
  if (opts.daemonUrl) connectSrc.push(opts.daemonUrl);
  if (opts.extraConnectSrc) connectSrc.push(...opts.extraConnectSrc);

  const imgSrc = ["'self'", 'data:', 'blob:'];
  const frameSrc = ["'self'"];
  const workerSrc = ["'self'", SANDPACK_CSP_WORKER_SRC];
  if (opts.allowSandpack) {
    frameSrc.push(SANDPACK_CSP_FRAME_SRC);
    imgSrc.push(SANDPACK_CSP_FRAME_SRC);
  }

  return {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    // TODO: drop 'unsafe-inline' once Ant Design supports CSP nonces.
    // fonts.bunny.net hosts the Inter font CSS imported by index.css.
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.bunny.net'],
    'img-src': imgSrc,
    'font-src': ["'self'", 'data:', 'https://fonts.bunny.net'],
    'connect-src': connectSrc,
    'frame-src': frameSrc,
    'worker-src': workerSrc,
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
  };
}

export interface ResolvedCsp {
  /** The resolved directives (built-in ⊕ extras ⊕ override). */
  directives: AgorCspDirectives;
  /** True when operator set `csp.disabled: true` (no CSP header emitted). */
  disabled: boolean;
  /** True when the CSP should be emitted as `Content-Security-Policy-Report-Only`. */
  reportOnly: boolean;
  /** When set, CSP violation reports are POSTed here. */
  reportUri?: string;
  /**
   * The reporting-group name that the `Report-To` header should advertise.
   * Kept in the resolved object (rather than hardcoded in the middleware) so
   * that the group in the `report-to` CSP directive and the group in the
   * `Report-To` header can never drift. When the operator overrides the
   * `report-to` directive with a custom group, this field reflects their
   * choice; otherwise it's the built-in default (`agor-csp`). Undefined when
   * reporting is not configured.
   */
  reportToGroup?: string;
  /** Pre-serialized header value (handy for tests and /health). */
  headerValue: string;
}

export interface ResolvedCors {
  /** Resolution strategy (see AgorCorsMode). */
  mode: AgorCorsMode;
  /** Explicit origins (used when mode=list). */
  origins: string[];
  /** Whether to emit Access-Control-Allow-Credentials. */
  credentials: boolean;
  /** Allowed methods (undefined = cors() default). */
  methods?: string[];
  /** Allowed request headers (undefined = reflect). */
  allowedHeaders?: string[];
  /** Preflight cache TTL in seconds (undefined = cors() default). */
  maxAgeSeconds?: number;
  /** Whether Sandpack origins are accepted. */
  allowSandpack: boolean;
}

export interface ResolvedSecurity {
  csp: ResolvedCsp;
  cors: ResolvedCors;
}

export interface ResolveSecurityOptions {
  /**
   * Daemon's own URL (added to `connect-src` so the UI can talk to it).
   */
  daemonUrl?: string;
  /**
   * Additional `connect-src` origins the caller wants unconditionally.
   * Usually empty — most operators should use `security.csp.extras` instead.
   */
  extraConnectSrc?: string[];
  /**
   * Legacy `daemon.cors_origins` values (for backwards compatibility).
   * Merged with `security.cors.origins` when the new key is absent.
   */
  legacyCorsOrigins?: string[];
  /**
   * Legacy `daemon.cors_allow_sandpack` value. When `security.cors.allow_sandpack`
   * is explicitly set (true OR false), that wins. When the new key is absent,
   * this legacy value is used. Defaults to `true`.
   */
  legacyAllowSandpack?: boolean;
  /**
   * `CORS_ORIGIN` environment variable value. Takes precedence over all config.
   * Parsed as comma-separated origins (same semantics as #1027).
   */
  corsOriginEnv?: string;
  /**
   * Callback for surfacing warnings to the operator (deprecation notices,
   * dangerous combinations, etc.). Defaults to `console.warn`.
   */
  onWarning?: (message: string) => void;
}

function isValidDirectiveName(name: string): boolean {
  return KNOWN_CSP_DIRECTIVES.has(name);
}

function validateDirectives(
  directives: AgorCspDirectives | undefined,
  label: 'extras' | 'override'
): void {
  if (!directives) return;
  for (const key of Object.keys(directives)) {
    if (!isValidDirectiveName(key)) {
      throw new Error(
        `security.csp.${label} contains unknown CSP directive "${key}". ` +
          `Directive names must be lowercase-hyphenated (e.g. "script-src"). ` +
          `Known directives: ${[...KNOWN_CSP_DIRECTIVES].sort().join(', ')}.`
      );
    }
    const sources = directives[key];
    if (!Array.isArray(sources)) {
      throw new Error(
        `security.csp.${label}.${key} must be an array of source strings, got ${typeof sources}.`
      );
    }
    for (const src of sources) {
      if (typeof src !== 'string') {
        throw new Error(
          `security.csp.${label}.${key} contains a non-string source (${typeof src}).`
        );
      }
    }
  }
}

/**
 * Merge defaults, extras, and override into a final directive set.
 *
 * Semantics:
 *   - `override` is authoritative per-directive: setting a key there wipes
 *     whatever defaults+extras produced for the same key.
 *   - `override: { "script-src": [] }` is legal and means "emit `script-src`
 *     with no sources" (effectively blocks that directive entirely). It is
 *     distinct from *omitting* the key, which means "use defaults+extras".
 *   - Duplicate source strings are de-duplicated while preserving order.
 */
function mergeDirectives(
  defaults: AgorCspDirectives,
  extras: AgorCspDirectives | undefined,
  override: AgorCspDirectives | undefined
): AgorCspDirectives {
  const result: AgorCspDirectives = {};

  for (const [key, sources] of Object.entries(defaults)) {
    result[key] = [...sources];
  }

  if (extras) {
    for (const [key, sources] of Object.entries(extras)) {
      const existing = result[key] ?? [];
      const seen = new Set(existing);
      const merged = [...existing];
      for (const src of sources) {
        if (!seen.has(src)) {
          seen.add(src);
          merged.push(src);
        }
      }
      result[key] = merged;
    }
  }

  if (override) {
    for (const [key, sources] of Object.entries(override)) {
      result[key] = [...sources];
    }
  }

  return result;
}

/**
 * Serialize a directive map into a CSP header value.
 *
 * Directives with empty source lists are emitted as `directive-name` (no
 * sources after the name) — this is the correct way to block a directive
 * entirely.
 *
 * Internal: the serialized value is already attached to `ResolvedCsp.headerValue`,
 * so callers outside this module should read that field instead of calling
 * this function directly.
 */
function serializeCsp(directives: AgorCspDirectives): string {
  return Object.entries(directives)
    .map(([name, sources]) => (sources.length === 0 ? name : `${name} ${sources.join(' ')}`))
    .join('; ');
}

function parseCorsEnv(value: string): { mode: AgorCorsMode; origins: string[] } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '*') {
    return { mode: 'wildcard', origins: [] };
  }
  const origins = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { mode: 'list', origins };
}

/**
 * Resolve the `security` config block into a ready-to-apply shape.
 */
export function resolveSecurity(
  config: AgorConfig,
  opts: ResolveSecurityOptions = {}
): ResolvedSecurity {
  const security: AgorSecuritySettings = config.security ?? {};
  const warn = opts.onWarning ?? ((m: string) => console.warn(m));

  // --- CSP ---------------------------------------------------------------
  const csp = security.csp ?? {};
  validateDirectives(csp.extras, 'extras');
  validateDirectives(csp.override, 'override');

  // Sandpack allow decision (shared with CORS below) — new key wins, then
  // legacy daemon.cors_allow_sandpack, defaulting to true.
  const corsSettings = security.cors ?? {};
  const allowSandpack = corsSettings.allow_sandpack ?? opts.legacyAllowSandpack ?? true;

  const defaults = buildDefaultDirectives({
    daemonUrl: opts.daemonUrl,
    extraConnectSrc: opts.extraConnectSrc,
    allowSandpack,
  });

  const merged = mergeDirectives(defaults, csp.extras, csp.override);

  // Wire up reporting: when report_uri is set, add it to the directive
  // set AND surface it so the daemon can mount a handler at that path.
  let reportToGroup: string | undefined;
  if (csp.report_uri) {
    if (typeof csp.report_uri !== 'string' || !csp.report_uri.trim()) {
      throw new Error('security.csp.report_uri must be a non-empty string.');
    }
    // Only auto-inject into the directive set if the operator hasn't already
    // pinned `report-uri`/`report-to` via override (which we honour verbatim).
    if (!merged['report-uri']) {
      merged['report-uri'] = [csp.report_uri];
    }
    if (!merged['report-to']) {
      merged['report-to'] = ['agor-csp'];
      reportToGroup = 'agor-csp';
    } else {
      // The operator pinned their own `report-to` group via override — use it
      // verbatim for the matching `Report-To` header so the two stay in sync.
      // If they wrote multiple groups, take the first (the first-listed group
      // is the one browsers try first per CSP3 §6.2.1).
      reportToGroup = merged['report-to'][0];
      if (!reportToGroup) {
        throw new Error(
          'security.csp.override.report-to must contain at least one group name ' +
            'when security.csp.report_uri is set, otherwise the Report-To header ' +
            'and the report-to directive will drift.'
        );
      }
    }
  }

  const cspResult: ResolvedCsp = {
    directives: merged,
    disabled: csp.disabled === true,
    reportOnly: csp.report_only === true,
    reportUri: csp.report_uri,
    reportToGroup,
    headerValue: serializeCsp(merged),
  };

  if (cspResult.disabled) {
    warn(
      '⚠️  security.csp.disabled=true — Content-Security-Policy header is NOT being emitted. ' +
        'This leaves the daemon vulnerable to script injection attacks and should only be used for debugging.'
    );
  }

  // --- CORS --------------------------------------------------------------
  // Env var takes precedence over all config (legacy behaviour preserved).
  let mode: AgorCorsMode = corsSettings.mode ?? 'list';
  let origins: string[] = [...(corsSettings.origins ?? opts.legacyCorsOrigins ?? [])];

  if (opts.corsOriginEnv) {
    const parsed = parseCorsEnv(opts.corsOriginEnv);
    if (parsed) {
      if (corsSettings.mode !== undefined || corsSettings.origins !== undefined) {
        warn(
          'CORS_ORIGIN env var overrides security.cors.* config values. ' +
            'Unset the env var to use config-file values.'
        );
      }
      mode = parsed.mode;
      origins = parsed.origins;
    }
  } else if (opts.legacyCorsOrigins && opts.legacyCorsOrigins.length > 0) {
    if (corsSettings.origins === undefined) {
      warn(
        'daemon.cors_origins is deprecated; migrate to security.cors.origins. ' +
          'The legacy value is still applied for now.'
      );
    } else {
      warn(
        'daemon.cors_origins is deprecated AND ignored because security.cors.origins ' +
          'is set. Remove daemon.cors_origins from your config.'
      );
    }
  }

  if (opts.legacyAllowSandpack !== undefined && corsSettings.allow_sandpack === undefined) {
    warn('daemon.cors_allow_sandpack is deprecated; migrate to security.cors.allow_sandpack.');
  }

  // Credentials default: true, unless mode is wildcard/reflect (spec forbids).
  let credentials = corsSettings.credentials ?? true;
  if ((mode === 'wildcard' || mode === 'reflect') && credentials === true) {
    if (corsSettings.credentials === true) {
      throw new Error(
        `security.cors.credentials=true is incompatible with cors.mode="${mode}". ` +
          'The CORS spec forbids credentialed wildcard/reflect responses (a credentialed ' +
          'request from any site would succeed). Either set mode: list, or set credentials: false.'
      );
    }
    // Default was true but mode forces false — downgrade silently with warning.
    warn(`⚠️  security.cors.mode=${mode} forces credentials=false (spec requirement).`);
    credentials = false;
  }

  const corsResult: ResolvedCors = {
    mode,
    origins,
    credentials,
    methods: corsSettings.methods,
    allowedHeaders: corsSettings.allowed_headers,
    maxAgeSeconds: corsSettings.max_age_seconds,
    allowSandpack,
  };

  return { csp: cspResult, cors: corsResult };
}

// ============================================================================
// Git config hardening (security.git_config_parameters)
// ============================================================================
// Defaults + resolver semantics; the env-var encoding lives in @agor/core/git.
// Design: docs/internal/credential-leak-defenses-2026-05-11.md.

/**
 * Conservative defaults. `transfer.credentialsInUrl=die` (git 2.41+) is
 * scoped to `remote.<name>.url` per git's docs — NOT `pushurl`, NOT argv.
 * The protocol/HFS/NTFS pairs are either git defaults already (modern git
 * or macOS/Windows) or near-zero risk on Linux. `fsckObjects` is deliberately
 * out — too prone to refusing legacy repos; opt in via `extras` if needed.
 */
const DEFAULT_GIT_CONFIG_PARAMETERS: readonly string[] = Object.freeze([
  'transfer.credentialsInUrl=die',
  'protocol.file.allow=user',
  'protocol.ext.allow=never',
  'core.protectHFS=true',
  'core.protectNTFS=true',
]);

export function getDefaultGitConfigParameters(): string[] {
  return [...DEFAULT_GIT_CONFIG_PARAMETERS];
}

function gitConfigParameterKey(pair: string): string {
  const trimmed = pair.trim();
  const eq = trimmed.indexOf('=');
  return eq >= 0 ? trimmed.slice(0, eq) : trimmed;
}

/**
 * Runtime validation for an `extras` or `override` list. YAML can produce
 * shapes the TS type doesn't catch (a bare string instead of an array, a
 * mix of strings and numbers, etc.), and silent acceptance would either
 * corrupt the Map merge (strings iterate as characters) or crash later in
 * the protocol encoder. Throw at config-load with a clear path.
 */
function validateGitConfigParameterList(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of strings`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${path} must be an array of strings; got ${typeof item}`);
    }
  }
  return value;
}

export function resolveGitConfigParameters(
  configured: AgorGitConfigParametersSettings | undefined
): readonly string[] {
  if (configured === undefined || configured === null) {
    return getDefaultGitConfigParameters();
  }

  // Flat-array shape was the v1 of this key on the design branch (now
  // superseded by { extras, override }). Catch operators who copied it from
  // earlier docs / forks and migrate them with a clear hint.
  if (Array.isArray(configured)) {
    throw new Error(
      'security.git_config_parameters: takes { extras: [...] } or { override: [...] }, ' +
        'not a flat array. Move your list under `extras` (to append to the safe defaults) ' +
        'or `override` (to replace them).'
    );
  }

  if (typeof configured !== 'object') {
    throw new Error(
      'security.git_config_parameters: must be an object with optional `extras` / `override` arrays'
    );
  }

  const extras = validateGitConfigParameterList(
    (configured as { extras?: unknown }).extras,
    'security.git_config_parameters.extras'
  );
  const override = validateGitConfigParameterList(
    (configured as { override?: unknown }).override,
    'security.git_config_parameters.override'
  );

  if (extras !== undefined && override !== undefined) {
    throw new Error(
      'security.git_config_parameters: cannot set both `extras` and `override`. ' +
        'Use `extras` to append to the safe defaults, or `override` to replace them entirely.'
    );
  }

  if (override !== undefined) return override;
  if (extras === undefined || extras.length === 0) return getDefaultGitConfigParameters();

  // Map-based merge handles defaults+extras AND duplicate keys within extras
  // (last write wins) AND whitespace normalization in one pass.
  const byKey = new Map<string, string>();
  for (const raw of [...DEFAULT_GIT_CONFIG_PARAMETERS, ...extras]) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    byKey.set(gitConfigParameterKey(trimmed), trimmed);
  }
  return [...byKey.values()];
}

/**
 * Replace userinfo in any URL with `<redacted>`. Catches creds embedded in
 * either the value (e.g. `http.proxy=http://USER:TOK@host/`) or the config
 * KEY (git config keys can carry URLs as subsections, e.g.
 * `url."https://USER:TOK@host/".insteadOf=…`). Anchored to `://` so SCP-form
 * `git@host:path` URLs aren't false-positively matched.
 */
export function redactUrlUserinfo(s: string): string {
  return s.replace(/:\/\/[^/@\s]+@/g, '://<redacted>@');
}

/** True when a pair still looks credential-bearing AFTER URL-userinfo redaction. */
export function gitConfigParameterLooksSecret(pair: string): boolean {
  return /authorization:/i.test(pair);
}

/**
 * Render for log: scrub URL userinfo from key+value, then mask the value if
 * the residue still matches an auth-header pattern.
 */
export function renderGitConfigParametersForLog(pairs: readonly string[]): string {
  return pairs
    .filter((p) => p.trim().length > 0)
    .map((pair) => {
      const scrubbed = redactUrlUserinfo(pair);
      if (!gitConfigParameterLooksSecret(scrubbed)) return scrubbed;
      return `${gitConfigParameterKey(scrubbed)}=<redacted>`;
    })
    .join(' ');
}
