/**
 * Sandpack config helpers
 *
 * Centralizes:
 *  - The allow-list of `SandpackConfig` properties authors may persist.
 *  - The template → env-var-prefix mapping used when synthesizing `.env`.
 *  - Default merging at render time.
 *  - Legacy-format detection so the UI can offer an agentic upgrade.
 *
 * The artifact runtime is arbitrary-JS-by-design — most "unsafe" Sandpack
 * props don't grant new capability beyond what the file map already allows.
 * The block list is deliberately minimal: anything that affects the parent
 * UI, the daemon-controlled bundler, or per-user CodeSandbox accounts.
 *
 * See `docs/internal/artifacts-roadmap-2026-05-09.md` (sanitizeSandpackConfig
 * allow list) for the rationale for each prop.
 */

import type {
  AgorGrants,
  ArtifactLegacyFormatReport,
  ArtifactLegacySignal,
  SandpackConfig,
  SandpackTemplate,
} from '@agor/core/types';

/**
 * Templates whose Sandpack runtime uses Vite. The synthesized `.env` keys
 * must be prefixed with `VITE_` so `import.meta.env.VITE_*` picks them up.
 */
const VITE_TEMPLATES = new Set<SandpackTemplate>(['react', 'react-ts', 'vue3', 'svelte', 'solid']);

/**
 * Templates that don't have a working dotenv path at all. The daemon emits
 * a warning if such an artifact has a non-empty `required_env_vars`.
 */
const NO_ENV_TEMPLATES = new Set<SandpackTemplate>(['vanilla', 'vanilla-ts']);

/**
 * Returns the prefix the daemon should apply when synthesizing `.env` for
 * the given template, or `null` if the template doesn't support a dotenv
 * path (the artifact will need to find another way to consume secrets).
 */
export function envVarPrefixForTemplate(template: SandpackTemplate): string | null {
  if (NO_ENV_TEMPLATES.has(template)) return null;
  if (VITE_TEMPLATES.has(template)) return 'VITE_';
  // CRA isn't a separate template in the current type — it ships as a
  // forked `react` build that consumers opt into. We default to `VITE_`
  // for `react` since the upstream Sandpack template is now Vite-based.
  // `vue` (Vue CLI), `angular` (Angular CLI), etc. consume plain
  // `process.env.X`.
  return '';
}

/**
 * Sanitize a `SandpackConfig` blob before persisting. Strips block-listed
 * props (with no error — silently dropping is friendlier than rejecting on
 * publish). Pass-through structure is preserved so authors get back
 * something close to what they sent.
 */
export function sanitizeSandpackConfig(input: unknown): SandpackConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const src = input as Record<string, unknown>;
  const out: SandpackConfig = {};

  if (typeof src.template === 'string') {
    out.template = src.template as SandpackTemplate;
  }

  if (src.customSetup && typeof src.customSetup === 'object') {
    const cs = src.customSetup as Record<string, unknown>;
    const customSetup: NonNullable<SandpackConfig['customSetup']> = {};
    if (cs.dependencies && typeof cs.dependencies === 'object') {
      customSetup.dependencies = sanitizeStringMap(cs.dependencies);
    }
    if (cs.devDependencies && typeof cs.devDependencies === 'object') {
      customSetup.devDependencies = sanitizeStringMap(cs.devDependencies);
    }
    if (typeof cs.entry === 'string') customSetup.entry = cs.entry;
    if (typeof cs.environment === 'string') customSetup.environment = cs.environment;
    // Block: customSetup.npmRegistries (private-registry confusion),
    //        customSetup.exportOptions (per-user CodeSandbox API token).
    out.customSetup = customSetup;
  }

  if (typeof src.theme === 'string' || (src.theme && typeof src.theme === 'object')) {
    out.theme = src.theme as SandpackConfig['theme'];
  }

  if (src.options && typeof src.options === 'object') {
    out.options = sanitizeOptions(src.options as Record<string, unknown>);
  }

  // Block: top-level teamId / sandboxId — bind to a CodeSandbox account.
  return out;
}

const ALLOWED_OPTION_KEYS = new Set<string>([
  'activeFile',
  'visibleFiles',
  'layout',
  'recompileMode',
  'recompileDelay',
  'initMode',
  'autorun',
  'autoReload',
  'showNavigator',
  'showLineNumbers',
  'showInlineErrors',
  'showRefreshButton',
  'showTabs',
  'showConsole',
  'showConsoleButton',
  'closableTabs',
  'startRoute',
  'codeEditor',
  'classes',
]);

const SAFE_CLASS_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeOptions(options: Record<string, unknown>): SandpackConfig['options'] {
  const out: NonNullable<SandpackConfig['options']> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) continue;
    if (key === 'classes') {
      out.classes = sanitizeClassMap(value);
      continue;
    }
    if (key === 'visibleFiles' && Array.isArray(value)) {
      out.visibleFiles = value.filter((v): v is string => typeof v === 'string');
      continue;
    }
    out[key as keyof typeof out] = value as never;
  }
  return out;
}

function sanitizeClassMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    // Defence in depth: classes are applied to parent UI components, so block
    // arbitrary class names that might collide with Agor's own styling. Only
    // allow plain identifier-like names.
    if (!SAFE_CLASS_NAME_RE.test(v)) continue;
    out[key] = v;
  }
  return out;
}

function sanitizeStringMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy format detection
// ─────────────────────────────────────────────────────────────────────────────

const HANDLEBARS_TOKEN_RE = /\{\{\s*agor\.(token|apiUrl|proxies\.([\w-]+)|user\w*)/g;
const HANDLEBARS_USER_ENV_RE = /\{\{\s*user\.env\.([A-Z_][A-Z0-9_]*)/g;
// Old format also rendered top-level `{{user.email}}` (note: NOT `agor.user…`)
// and `{{artifact.id}}` / `{{artifact.boardId}}`. Presence-only — no /g flag
// because we only care whether the variable appears, not where.
const HANDLEBARS_USER_EMAIL_RE = /\{\{\s*user\.email\s*\}\}/;
const HANDLEBARS_ARTIFACT_ID_RE = /\{\{\s*artifact\.id\s*\}\}/;
const HANDLEBARS_ARTIFACT_BOARD_ID_RE = /\{\{\s*artifact\.boardId\s*\}\}/;

/**
 * Inspect an artifact's file map + config columns and report which legacy-format
 * signals are present. Used to render the safe-degraded warning banner with
 * an interpolated upgrade prompt.
 */
export function detectLegacyFormat(artifact: {
  artifact_id?: string;
  files?: Record<string, string>;
  sandpack_config?: SandpackConfig;
  required_env_vars?: string[];
  agor_grants?: AgorGrants;
}): ArtifactLegacyFormatReport {
  const files = artifact.files ?? {};
  const signals = new Set<ArtifactLegacySignal>();
  const detectedEnvVars = new Set<string>();
  const detectedGrants = new Set<string>();

  if (files['/sandpack.json'] || files['sandpack.json']) {
    signals.add('has_sandpack_json');
  }

  const hasAgorConfig = files['/agor.config.js'] || files['agor.config.js'];
  if (hasAgorConfig) signals.add('has_agor_config_js');

  if (!artifact.sandpack_config || Object.keys(artifact.sandpack_config).length === 0) {
    // Only flag missing sandpack_config if there's another legacy signal —
    // a brand-new artifact with sensible defaults is fine.
    if (signals.size > 0) signals.add('no_sandpack_config');
  }

  for (const [, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    for (const m of content.matchAll(HANDLEBARS_TOKEN_RE)) {
      signals.add('has_handlebars_token');
      const which = m[1];
      if (which === 'token') detectedGrants.add('agor_token');
      else if (which === 'apiUrl') detectedGrants.add('agor_api_url');
      else if (which.startsWith('proxies.')) {
        // matched group 2 is the vendor name
        if (m[2]) detectedGrants.add(`agor_proxies:${m[2]}`);
      } else if (which === 'userEmail' || which === 'user') {
        detectedGrants.add('agor_user_email');
      }
    }
    for (const m of content.matchAll(HANDLEBARS_USER_ENV_RE)) {
      signals.add('has_handlebars_user_env');
      detectedEnvVars.add(m[1]);
    }
    if (HANDLEBARS_USER_EMAIL_RE.test(content)) {
      signals.add('has_handlebars_user_email');
      detectedGrants.add('agor_user_email');
    }
    if (HANDLEBARS_ARTIFACT_ID_RE.test(content)) {
      signals.add('has_handlebars_artifact_ref');
      detectedGrants.add('agor_artifact_id');
    }
    if (HANDLEBARS_ARTIFACT_BOARD_ID_RE.test(content)) {
      signals.add('has_handlebars_artifact_ref');
      detectedGrants.add('agor_board_id');
    }
  }

  const isLegacy = signals.size > 0;
  const detectedEnvVarsArr = [...detectedEnvVars].sort();
  const detectedGrantsArr = [...detectedGrants].sort();
  const upgradeInstructions = renderUpgradeInstructions({
    artifactId: artifact.artifact_id,
    detectedEnvVars: detectedEnvVarsArr,
    detectedGrants: detectedGrantsArr,
    signals: [...signals],
  });

  return {
    is_legacy: isLegacy,
    signals: [...signals],
    detected_env_vars: detectedEnvVarsArr,
    detected_grants: detectedGrantsArr,
    upgrade_instructions: upgradeInstructions,
  };
}

function renderUpgradeInstructions(input: {
  artifactId?: string;
  detectedEnvVars: string[];
  detectedGrants: string[];
  signals: ArtifactLegacySignal[];
}): string {
  // Translate the parsed detection result back into the new-format vocab.
  const proxyVendors: string[] = [];
  const grantsObj: Record<string, true | string[]> = {};
  for (const g of input.detectedGrants) {
    if (g.startsWith('agor_proxies:')) {
      proxyVendors.push(g.slice('agor_proxies:'.length));
    } else {
      grantsObj[g] = true;
    }
  }
  if (proxyVendors.length > 0) {
    grantsObj.agor_proxies = proxyVendors.sort();
  }

  const envVarsLine =
    input.detectedEnvVars.length > 0
      ? `[${input.detectedEnvVars.map((v) => `"${v}"`).join(', ')}]`
      : '[]';
  const grantsLine = Object.keys(grantsObj).length > 0 ? JSON.stringify(grantsObj) : '{}';

  const removals: string[] = [];
  if (input.signals.includes('has_sandpack_json')) removals.push('sandpack.json');
  if (input.signals.includes('has_agor_config_js')) removals.push('agor.config.js');
  const removalsLine = removals.length > 0 ? removals.join(' and ') : '(none)';

  // Pin the artifact id into the prompt so an agent given this string knows
  // exactly which row to migrate. Without it the agent has to guess (or
  // worse, batch-migrate every legacy artifact it can find).
  const artifactRef = input.artifactId ? `"${input.artifactId}"` : '<this artifact id>';

  return [
    `Migrate ONLY this artifact: ${artifactRef}. Do not touch any other artifacts.`,
    '',
    `1. Read the current files: agor_artifacts_get(artifactId=${artifactRef}).`,
    `2. Republish with the new format: agor_artifacts_publish(folderPath=<tmp folder you write the rewritten files to>, artifactId=${artifactRef}, …).`,
    '',
    'In the rewritten file map:',
    `  - Drop these legacy files: ${removalsLine}`,
    '  - Update source files to read env vars via the bundler convention',
    '    (Vite: import.meta.env.VITE_*, CRA: process.env.REACT_APP_*,',
    '    Node: process.env.*) instead of {{ user.env.* }} or',
    '    {{ agor.* }} Handlebars tokens.',
    '',
    'In the publish call, set:',
    '  - sandpack_config (template, customSetup.entry, customSetup.dependencies)',
    '    so the artifact still renders correctly.',
    `  - required_env_vars: ${envVarsLine}`,
    `  - agor_grants: ${grantsLine}`,
    '',
    'Use agor_search_tools for the full publish/get tool schemas.',
  ].join('\n');
}
