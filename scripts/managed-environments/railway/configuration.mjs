import { createHash } from 'node:crypto';
import { requireValue, uuid } from './api.mjs';

export const MARKER = 'AGOR_PREVIEW_BINDING';
// Non-secret deletion receipt survives removal of the service's binding marker.
export const CLEANUP_MARKER = 'AGOR_PREVIEW_CLEANUP';
export function profileSettings(profile = 'sqlite') {
  requireValue(['sqlite', 'docs'].includes(profile), 'Expected --profile sqlite or docs.');
  return profile === 'docs'
    ? { dockerfile: 'docker/Dockerfile.docs-preview', appPath: '/', healthPath: '/' }
    : { dockerfile: 'docker/Dockerfile', appPath: '/ui/', healthPath: '/health' };
}
export function configuration(env, input) {
  profileSettings(input.profile);
  if (env.RAILWAY_AGOR_PROJECT_ID && !env.RAILWAY_PREVIEW_CONFIG) {
    requireValue(
      uuid(env.RAILWAY_AGOR_PROJECT_ID),
      'RAILWAY_AGOR_PROJECT_ID must be the project UUID, not a URL.'
    );
    requireValue(
      uuid(input.binding) &&
        /^[\w.-]+\/[\w.-]+$/.test(input.repository ?? '') &&
        typeof input.ref === 'string' &&
        input.ref.length > 0 &&
        input.ref.length <= 250 &&
        [...input.ref].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) !== 127),
      'Invalid Agor branch UUID, repository or Git ref.'
    );
    return {
      projectId: env.RAILWAY_AGOR_PROJECT_ID,
      repository: input.repository,
      maxPreviews: 3,
      sharedProject: true,
    };
  }
  let config;
  try {
    config = JSON.parse(env.RAILWAY_PREVIEW_CONFIG);
  } catch {
    /* Never echo config. */
  }
  requireValue(
    config?.enabled === true &&
      uuid(config.projectId) &&
      uuid(config.workspaceId) &&
      typeof config.tenantId === 'string' &&
      config.tenantId.length > 0 &&
      config.tenantId.length <= 200 &&
      /^[\w.-]+\/[\w.-]+$/.test(config.repository ?? '') &&
      Number.isInteger(config.maxPreviews ?? 3) &&
      (config.maxPreviews ?? 3) >= 1 &&
      (config.maxPreviews ?? 3) <= 10,
    'Opt in with secure Global RAILWAY_AGOR_PROJECT_ID (project UUID), or legacy RAILWAY_PREVIEW_CONFIG: {"enabled":true,"workspaceId":"UUID","projectId":"UUID","tenantId":"AGOR_TENANT_ID","repository":"owner/repo","maxPreviews":3}. Use a dedicated preview project, never bootstrap/production.'
  );
  requireValue(
    uuid(input.binding) &&
      input.repository === config.repository &&
      typeof input.ref === 'string' &&
      input.ref.length > 0 &&
      input.ref.length <= 250 &&
      [...input.ref].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) !== 127),
    'Branch UUID/ref is invalid or repository does not match the operator-authorized configuration.'
  );
  requireValue(
    !env.RAILWAY_AGOR_PROJECT_ID || env.RAILWAY_AGOR_PROJECT_ID === config.projectId,
    'Project settings conflict; remove stale RAILWAY_PREVIEW_CONFIG before changing projects.'
  );
  return { ...config, maxPreviews: config.maxPreviews ?? 3 };
}
export function identity(config, input) {
  return {
    version: config.sharedProject ? 2 : 1,
    ...(config.sharedProject ? {} : { tenantId: config.tenantId }),
    workspaceId: config.workspaceId,
    projectId: config.projectId,
    repository: config.repository,
    branchId: input.binding,
    ref: input.ref,
    // Preserve every existing SQLite identity, including legacy receipts.
    ...(input.profile === 'docs' ? { profile: 'docs' } : {}),
  };
}
export function resourceName(record) {
  // Ref deliberately excluded: renaming a branch must fail ownership checks,
  // not silently allocate a new preview and abandon its old data.
  return `agor-${createHash('sha256')
    .update(
      JSON.stringify([
        record.tenantId,
        record.workspaceId,
        record.projectId,
        record.repository,
        record.branchId,
        ...(record.profile === 'docs' ? ['docs'] : []),
      ])
    )
    .digest('hex')
    .slice(0, record.version === 2 ? 20 : 32)}`;
}
export function appVariables(record, domain, password, previewBase = 'runtime-build') {
  if (record.profile === 'docs') {
    return {
      [MARKER]: JSON.stringify(record),
      RAILWAY_DOCKERFILE_PATH: profileSettings('docs').dockerfile,
      AGOR_SOURCE_REPO: `https://github.com/${record.repository}.git`,
      AGOR_SOURCE_BRANCH: record.ref,
      NEXT_PUBLIC_SITE_URL: `https://${domain}`,
      AGOR_DOCS_PREVIEW_ORIGIN: `https://${domain}`,
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'development',
      HOME: '/home/agor',
      PORT: '3030',
    };
  }
  return {
    [MARKER]: JSON.stringify(record),
    AGOR_ADMIN_PASSWORD: password,
    AGOR_ADMIN_REQUIRE_PASSWORD_CHANGE: 'false',
    AGOR_RUNTIME_TARGET: 'railway-preview',
    AGOR_PREVIEW_BASE: previewBase,
    AGOR_RUNTIME_MODE: 'watch',
    AGOR_SOURCE_REPO: `https://github.com/${record.repository}.git`,
    AGOR_SOURCE_BRANCH: record.ref,
    AGOR_MANAGED_BRANCH_ID: record.branchId,
    ...(record.tenantId ? { AGOR_MANAGED_TENANT_ID: record.tenantId } : {}),
    AGOR_AGENTIC_TOOLS: 'claude-code,codex,opencode,copilot',
    AGOR_RUNTIME_ADD_TOOLS: 'claude-code,codex,opencode,copilot',
    RAILWAY_DOCKERFILE_PATH: 'docker/Dockerfile',
    NODE_ENV: 'production',
    HOME: '/home/agor',
    PORT: '3030',
    DAEMON_PORT: '3030',
    DAEMON_HOST: '0.0.0.0',
    AGOR_BASE_URL: `https://${domain}`,
    CORS_ORIGIN: `https://${domain}`,
  };
}
