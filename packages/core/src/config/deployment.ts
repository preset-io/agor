import type {
  AgorConfig,
  AgorDeploymentMode,
  AgorExecutorBaseRepositoryStorage,
  AgorExecutorBranchWorkspaceStorage,
  AgorExecutorUserHomeStorage,
  AgorHaSupportProfile,
} from './types';

export const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_REDIS_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_REDIS_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_REDIS_RECONNECT_BASE_DELAY_MS = 100;
export const DEFAULT_REDIS_RECONNECT_MAX_DELAY_MS = 2_000;

export interface ResolvedRedisSettings {
  /** Kept private to the connection factory; never include this in logs or health output. */
  url: string;
  keyPrefix: string;
  connectTimeoutMs: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
}

export interface ResolvedExecutorStorageSettings {
  userHome: AgorExecutorUserHomeStorage;
  branchWorkspace: AgorExecutorBranchWorkspaceStorage;
  baseRepository: AgorExecutorBaseRepositoryStorage;
}

export type ResolvedDeploymentConfig =
  | { mode: 'standalone' }
  | {
      mode: 'ha';
      supportProfile: 'constrained-active-active';
      capabilities: {
        taskExecution: true;
        executorTokenAuthority: true;
        interactivePermissions: false;
        scheduler: true;
        sessionQueue: true;
        taskRuntimeReconciliation: true;
        knowledgeEmbeddingIndexer: true;
        statelessMcp: true;
        statefulMcp: false;
        completionCallbackDurableAdmission: true;
        completionCallbackPreAdmissionRecovery: false;
        widgetResolutionDurableClaim: true;
        codexCredentialFiles: boolean;
        codexDeviceAuth: false;
        processAffineAuth: false;
        gatewayListeners: true;
        gatewayOutboundExactlyOnce: false;
        environmentHealthMonitor: false;
        artifactRuntimeIntrospection: false;
      };
      redis: ResolvedRedisSettings;
      executorStorage: ResolvedExecutorStorageSettings;
      topology:
        | { execution: 'shared-local'; sharedFilesystem: true; ingressAffinity: true }
        | { execution: 'external'; sharedFilesystem: false; ingressAffinity: true };
    };

type DeploymentEnv = Record<string, string | undefined>;

function envInteger(env: DeploymentEnv, name: string): number | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`Config error: ${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Config error: ${name} must be a positive integer`);
  }
  return parsed;
}

function envBoolean(env: DeploymentEnv, name: string): boolean | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Config error: ${name} must be true or false`);
}

function positiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Config error: ${path} must be a positive integer`);
  }
  return value;
}

export function validateRedisUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Config error: deployment.redis.url must be a valid redis:// or rediss:// URL');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('Config error: deployment.redis.url must use redis:// or rediss://');
  }
  if (!url.hostname || url.hash) {
    throw new Error(
      'Config error: deployment.redis.url must include a host and must not include a fragment'
    );
  }
  if (url.pathname !== '' && url.pathname !== '/' && !/^\/\d+$/.test(url.pathname)) {
    throw new Error('Config error: deployment.redis.url path must be a numeric Redis database');
  }
  return raw;
}

export function validateRedisKeyPrefix(raw: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(raw)) {
    throw new Error(
      'Config error: deployment.redis.key_prefix must be 1-63 letters, digits, dots, underscores, or hyphens and start with a letter or digit'
    );
  }
  return raw;
}

function effectiveDatabaseDialect(config: AgorConfig, env: DeploymentEnv): 'sqlite' | 'postgresql' {
  if (env.AGOR_DB_DIALECT === 'postgresql' || env.AGOR_DB_DIALECT === 'sqlite') {
    return env.AGOR_DB_DIALECT;
  }
  const databaseUrl = env.DATABASE_URL ?? config.database?.postgresql?.url;
  if (databaseUrl && /^(postgres(?:ql)?|pg):\/\//i.test(databaseUrl)) return 'postgresql';
  return config.database?.dialect === 'postgresql' ? 'postgresql' : 'sqlite';
}

/**
 * Resolve the explicit deployment boundary. REDIS_URL is deliberately ignored
 * in standalone mode so adding a shared cache cannot accidentally claim HA.
 */
export function resolveDeploymentConfig(
  config: AgorConfig,
  env: DeploymentEnv = process.env,
  runtimeDatabaseUrl?: string
): ResolvedDeploymentConfig {
  const mode = (env.AGOR_DEPLOYMENT_MODE ??
    config.deployment?.mode ??
    'standalone') as AgorDeploymentMode;
  if (mode !== 'standalone' && mode !== 'ha') {
    throw new Error('Config error: deployment.mode must be one of: standalone, ha');
  }
  if (mode === 'standalone') return { mode };

  if (effectiveDatabaseDialect(config, env) !== 'postgresql') {
    throw new Error('Config error: deployment.mode ha requires PostgreSQL');
  }
  // The daemon resolves its database URL before startDaemon() loads an optional
  // configPath/config object because the selected schema is process-global.
  // Validate that actual runtime value as well as the requested config so HA
  // cannot claim PostgreSQL while the daemon is really opening SQLite.
  if (runtimeDatabaseUrl !== undefined && !/^(postgres(?:ql)?|pg):\/\//i.test(runtimeDatabaseUrl)) {
    throw new Error(
      'Config error: deployment.mode ha requires the runtime database to be PostgreSQL'
    );
  }
  const supportProfile = (env.AGOR_HA_SUPPORT_PROFILE ?? config.deployment?.ha?.support_profile) as
    | AgorHaSupportProfile
    | undefined;
  if (supportProfile !== 'constrained-active-active') {
    throw new Error(
      'Config error: HA requires deployment.ha.support_profile: constrained-active-active; unsupported process-affine flows remain unavailable'
    );
  }
  if (!env.AGOR_JWT_SECRET || env.AGOR_JWT_SECRET.length < 32) {
    throw new Error(
      'Config error: HA requires an explicitly supplied AGOR_JWT_SECRET of at least 32 characters'
    );
  }
  if (!env.AGOR_MASTER_SECRET || env.AGOR_MASTER_SECRET.length < 32) {
    throw new Error(
      'Config error: HA requires an explicitly supplied AGOR_MASTER_SECRET of at least 32 characters'
    );
  }
  const executionTopology = (env.AGOR_HA_EXECUTION_TOPOLOGY ??
    config.deployment?.ha?.execution_topology) as 'shared-local' | 'external' | undefined;
  if (executionTopology !== 'shared-local' && executionTopology !== 'external') {
    throw new Error(
      'Config error: HA requires deployment.ha.execution_topology: shared-local or external'
    );
  }
  const sharedFilesystem =
    envBoolean(env, 'AGOR_HA_SHARED_FILESYSTEM') ??
    config.deployment?.ha?.shared_filesystem ??
    false;
  const ingressAffinity =
    envBoolean(env, 'AGOR_HA_INGRESS_AFFINITY') ?? config.deployment?.ha?.ingress_affinity ?? false;
  if (executionTopology === 'shared-local' && !sharedFilesystem) {
    throw new Error(
      'Config error: HA execution_topology shared-local requires deployment.ha.shared_filesystem: true'
    );
  }
  if (executionTopology === 'external' && sharedFilesystem) {
    throw new Error(
      'Config error: HA execution_topology external must not assert deployment.ha.shared_filesystem'
    );
  }
  if (executionTopology === 'external' && !config.execution?.executor_command_template?.trim()) {
    throw new Error(
      'Config error: HA execution_topology external requires execution.executor_command_template'
    );
  }
  if (executionTopology === 'external') {
    let publicUrl: URL;
    try {
      publicUrl = new URL(config.daemon?.public_url ?? '');
    } catch {
      throw new Error(
        'Config error: HA execution_topology external requires a valid daemon.public_url for executor callbacks'
      );
    }
    if (
      (publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') ||
      !publicUrl.hostname ||
      publicUrl.username !== '' ||
      publicUrl.password !== '' ||
      publicUrl.search !== '' ||
      publicUrl.hash !== ''
    ) {
      throw new Error(
        'Config error: HA execution_topology external requires an http(s), credential-free daemon.public_url without query or fragment for executor callbacks'
      );
    }
  }
  if (!ingressAffinity) {
    throw new Error(
      'Config error: HA requires deployment.ha.ingress_affinity: true for Engine.IO polling'
    );
  }
  if (config.execution?.allow_web_terminal !== false) {
    throw new Error('Config error: HA currently requires execution.allow_web_terminal: false');
  }
  if (config.execution?.managed_envs_execution_mode !== 'webhook-only') {
    throw new Error(
      'Config error: HA currently requires execution.managed_envs_execution_mode: webhook-only'
    );
  }

  const executorStorage = config.execution?.executor_storage;
  if (
    !executorStorage?.user_home ||
    !executorStorage.branch_workspace ||
    !executorStorage.base_repository
  ) {
    throw new Error(
      'Config error: HA requires explicit execution.executor_storage.user_home, branch_workspace, and base_repository guarantees'
    );
  }
  if (executionTopology === 'shared-local') {
    if (executorStorage.branch_workspace === 'replica-local') {
      throw new Error(
        'Config error: HA shared-local execution requires a shared or persistent-per-branch execution.executor_storage.branch_workspace'
      );
    }
    if (executorStorage.base_repository === 'replica-local') {
      throw new Error(
        'Config error: HA shared-local execution cannot use replica-local execution.executor_storage.base_repository'
      );
    }
  } else if (executorStorage.branch_workspace === 'replica-local') {
    throw new Error(
      'Config error: HA external execution requires a shared or persistent-per-branch execution.executor_storage.branch_workspace'
    );
  }

  const branchStorage = config.execution?.branch_storage;
  const allowedBranchModes = branchStorage?.allowed_modes ?? ['worktree', 'clone'];
  const defaultBranchMode = branchStorage?.default_mode ?? 'worktree';
  if (!allowedBranchModes.includes(defaultBranchMode)) {
    throw new Error(
      'Config error: HA requires execution.branch_storage.default_mode to appear in allowed_modes'
    );
  }
  if (
    executorStorage.base_repository === 'unavailable' &&
    (defaultBranchMode !== 'clone' || allowedBranchModes.some((mode) => mode !== 'clone'))
  ) {
    throw new Error(
      'Config error: execution.executor_storage.base_repository unavailable requires clone-only execution.branch_storage (default_mode: clone, allowed_modes: [clone]); worktrees require the base repository metadata'
    );
  }

  const redis = config.deployment?.redis;
  const url = validateRedisUrl(env.REDIS_URL ?? redis?.url ?? '');
  const keyPrefix = validateRedisKeyPrefix(env.AGOR_REDIS_KEY_PREFIX ?? redis?.key_prefix ?? '');
  const connectTimeoutMs = positiveInteger(
    envInteger(env, 'AGOR_REDIS_CONNECT_TIMEOUT_MS') ??
      redis?.connect_timeout_ms ??
      DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
    'deployment.redis.connect_timeout_ms'
  );
  const startupTimeoutMs = positiveInteger(
    envInteger(env, 'AGOR_REDIS_STARTUP_TIMEOUT_MS') ??
      redis?.startup_timeout_ms ??
      DEFAULT_REDIS_STARTUP_TIMEOUT_MS,
    'deployment.redis.startup_timeout_ms'
  );
  const requestTimeoutMs = positiveInteger(
    envInteger(env, 'AGOR_REDIS_REQUEST_TIMEOUT_MS') ??
      redis?.request_timeout_ms ??
      DEFAULT_REDIS_REQUEST_TIMEOUT_MS,
    'deployment.redis.request_timeout_ms'
  );
  const reconnectBaseDelayMs = positiveInteger(
    envInteger(env, 'AGOR_REDIS_RECONNECT_BASE_DELAY_MS') ??
      redis?.reconnect_base_delay_ms ??
      DEFAULT_REDIS_RECONNECT_BASE_DELAY_MS,
    'deployment.redis.reconnect_base_delay_ms'
  );
  const reconnectMaxDelayMs = positiveInteger(
    envInteger(env, 'AGOR_REDIS_RECONNECT_MAX_DELAY_MS') ??
      redis?.reconnect_max_delay_ms ??
      DEFAULT_REDIS_RECONNECT_MAX_DELAY_MS,
    'deployment.redis.reconnect_max_delay_ms'
  );
  if (reconnectMaxDelayMs < reconnectBaseDelayMs) {
    throw new Error('Config error: Redis maximum reconnect delay must be at least its base delay');
  }

  return {
    mode,
    supportProfile,
    capabilities: {
      taskExecution: true,
      executorTokenAuthority: true,
      interactivePermissions: false,
      scheduler: true,
      sessionQueue: true,
      taskRuntimeReconciliation: true,
      knowledgeEmbeddingIndexer: true,
      statelessMcp: true,
      statefulMcp: false,
      completionCallbackDurableAdmission: true,
      completionCallbackPreAdmissionRecovery: false,
      widgetResolutionDurableClaim: true,
      codexCredentialFiles: executorStorage.user_home !== 'replica-local',
      codexDeviceAuth: false,
      processAffineAuth: false,
      gatewayListeners: true,
      gatewayOutboundExactlyOnce: false,
      environmentHealthMonitor: false,
      artifactRuntimeIntrospection: false,
    },
    redis: {
      url,
      keyPrefix,
      connectTimeoutMs,
      startupTimeoutMs,
      requestTimeoutMs,
      reconnectBaseDelayMs,
      reconnectMaxDelayMs,
    },
    executorStorage: {
      userHome: executorStorage.user_home,
      branchWorkspace: executorStorage.branch_workspace,
      baseRepository: executorStorage.base_repository,
    },
    topology:
      executionTopology === 'shared-local'
        ? { execution: 'shared-local', sharedFilesystem: true, ingressAffinity: true }
        : { execution: 'external', sharedFilesystem: false, ingressAffinity: true },
  };
}
