/**
 * Service tier configuration for lean daemon mode.
 *
 * Controls how each service group is registered and exposed:
 * - off:      Not registered at all (saves memory, boot time)
 * - internal: Registered but blocked from external REST/WS access
 * - readonly: Registered, only get/find exposed externally
 * - on:       Full registration with all methods
 *
 * Progression: off < internal < readonly < on
 */
export const SERVICE_TIERS = ['off', 'internal', 'readonly', 'on'] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/** Numeric rank for tier comparison */
export const SERVICE_TIER_RANK: Record<ServiceTier, number> = {
  off: 0,
  internal: 1,
  readonly: 2,
  on: 3,
};

/**
 * The 13 service groups configurable in config.yaml under `services:`.
 * All default to 'on' for backward compatibility.
 */
export interface DaemonServicesConfig {
  /** sessions, tasks, messages — the prompt loop */
  core?: ServiceTier;
  /** worktree CRUD + board placement */
  worktrees?: ServiceTier;
  /** repository management */
  repos?: ServiceTier;
  /** user accounts + auth */
  users?: ServiceTier;
  /** spatial canvas boards + board-objects + board-comments */
  boards?: ServiceTier;
  /** kanban cards + card types */
  cards?: ServiceTier;
  /** sandpack artifacts */
  artifacts?: ServiceTier;
  /** Slack/Discord/GitHub integrations */
  gateway?: ServiceTier;
  /** cron-based session spawning */
  scheduler?: ServiceTier;
  /** web terminal access */
  terminals?: ServiceTier;
  /** file system browsing (file, files, context) */
  file_browser?: ServiceTier;
  /** MCP server configuration + OAuth */
  mcp_servers?: ServiceTier;
  /** usage analytics */
  leaderboard?: ServiceTier;
  /** Serve UI bundle and static assets (default: on). Set to 'off' for headless/executor pods. */
  static_files?: 'on' | 'off';
}

/**
 * Service group names (excludes non-service toggles like static_files).
 */
export type ServiceGroupName = Exclude<keyof DaemonServicesConfig, 'static_files'>;

/** All service group names as an array (useful for iteration) */
export const SERVICE_GROUP_NAMES: ServiceGroupName[] = [
  'core',
  'worktrees',
  'repos',
  'users',
  'boards',
  'cards',
  'artifacts',
  'gateway',
  'scheduler',
  'terminals',
  'file_browser',
  'mcp_servers',
  'leaderboard',
];

/**
 * Allowed tiers per service group.
 * Core infrastructure services (core, worktrees, repos, users) cannot be turned off —
 * the daemon doesn't function without them.
 */
export const ALLOWED_SERVICE_TIERS: Record<ServiceGroupName, readonly ServiceTier[]> = {
  core: ['on', 'readonly', 'internal'],
  worktrees: ['on', 'readonly', 'internal'],
  repos: ['on', 'readonly', 'internal'],
  users: ['on', 'readonly', 'internal'],
  boards: ['on', 'readonly', 'internal', 'off'],
  cards: ['on', 'readonly', 'internal', 'off'],
  artifacts: ['on', 'readonly', 'internal', 'off'],
  gateway: ['on', 'readonly', 'internal', 'off'],
  scheduler: ['on', 'readonly', 'internal', 'off'],
  terminals: ['on', 'readonly', 'internal', 'off'],
  file_browser: ['on', 'readonly', 'internal', 'off'],
  mcp_servers: ['on', 'readonly', 'internal', 'off'],
  leaderboard: ['on', 'readonly', 'internal', 'off'],
};

/**
 * Cross-service dependency declarations.
 *
 * Key = service group, Value = groups it depends on (must be at least 'internal').
 * e.g., core depends on users (sessions→users.get) and worktrees (sessions→worktrees.get)
 */
export const SERVICE_DEPENDENCIES: Partial<Record<ServiceGroupName, ServiceGroupName[]>> = {
  core: ['users', 'worktrees'],
  scheduler: ['core', 'worktrees'],
  gateway: ['core', 'worktrees'],
};

/**
 * Default tier for all service groups (backward-compatible: everything on).
 */
export const DEFAULT_SERVICE_TIER: ServiceTier = 'on';

/**
 * Mapping from service group to MCP tool domain names.
 * Used for conditional MCP tool registration.
 */
export const SERVICE_GROUP_TO_MCP_DOMAINS: Partial<Record<ServiceGroupName, string[]>> = {
  core: ['sessions'],
  worktrees: ['worktrees', 'environment'],
  repos: ['repos'],
  users: ['users'],
  boards: ['boards'],
  cards: ['cards'],
  artifacts: ['artifacts', 'proxies'],
  mcp_servers: ['mcp-servers'],
  leaderboard: ['analytics'],
};

/**
 * Resolve the effective tier for a service group, applying defaults.
 */
export function getServiceTier(
  config: DaemonServicesConfig | undefined,
  group: ServiceGroupName
): ServiceTier {
  return config?.[group] ?? DEFAULT_SERVICE_TIER;
}

/**
 * Check if a service group is enabled (tier > 'off').
 */
export function isServiceEnabled(
  config: DaemonServicesConfig | undefined,
  group: ServiceGroupName
): boolean {
  return getServiceTier(config, group) !== 'off';
}

/**
 * Check if a service group allows external access (tier >= 'readonly').
 */
export function isServiceExternallyAccessible(
  config: DaemonServicesConfig | undefined,
  group: ServiceGroupName
): boolean {
  const tier = getServiceTier(config, group);
  return SERVICE_TIER_RANK[tier] >= SERVICE_TIER_RANK.readonly;
}

/**
 * Check if a service group allows mutations externally (tier === 'on').
 */
export function isServiceFullAccess(
  config: DaemonServicesConfig | undefined,
  group: ServiceGroupName
): boolean {
  return getServiceTier(config, group) === 'on';
}

export interface ServiceTierViolation {
  /** The service group with an invalid tier */
  group: ServiceGroupName;
  /** The tier that was set */
  tier: ServiceTier;
  /** The tiers that are allowed */
  allowed: readonly ServiceTier[];
}

/**
 * Validate that each service group's configured tier is in its allowed set.
 * Returns violations for disallowed tiers (e.g., core: 'off').
 */
export function validateAllowedTiers(
  config: DaemonServicesConfig | undefined
): ServiceTierViolation[] {
  if (!config) return [];
  const violations: ServiceTierViolation[] = [];

  for (const group of SERVICE_GROUP_NAMES) {
    const tier = config[group];
    if (tier === undefined) continue; // will use default ('on'), always allowed
    const allowed = ALLOWED_SERVICE_TIERS[group];
    if (!allowed.includes(tier)) {
      violations.push({ group, tier, allowed });
    }
  }

  return violations;
}

export interface ServiceDependencyViolation {
  /** The service that has a dependency */
  service: ServiceGroupName;
  /** The dependency that's not met */
  dependency: ServiceGroupName;
  /** Current tier of the dependency */
  currentTier: ServiceTier;
  /** Minimum required tier */
  requiredTier: ServiceTier;
}

/**
 * Validate service dependencies. Returns violations where a service is enabled
 * but its dependency is 'off' (must be at least 'internal').
 */
export function validateServiceDependencies(
  config: DaemonServicesConfig | undefined
): ServiceDependencyViolation[] {
  const violations: ServiceDependencyViolation[] = [];

  for (const [service, deps] of Object.entries(SERVICE_DEPENDENCIES)) {
    const serviceGroup = service as ServiceGroupName;
    const serviceTier = getServiceTier(config, serviceGroup);

    // Only check deps if the service itself is enabled
    if (serviceTier === 'off') continue;

    for (const dep of deps!) {
      const depTier = getServiceTier(config, dep);
      if (depTier === 'off') {
        violations.push({
          service: serviceGroup,
          dependency: dep,
          currentTier: depTier,
          requiredTier: 'internal',
        });
      }
    }
  }

  return violations;
}

/**
 * Auto-promote dependencies to minimum required tier ('internal').
 * Returns a new config with promotions applied, plus a list of what was promoted.
 */
export function autoPromoteDependencies(config: DaemonServicesConfig): {
  config: DaemonServicesConfig;
  promotions: Array<{ group: ServiceGroupName; from: ServiceTier; to: ServiceTier }>;
} {
  const result = { ...config };
  const promotions: Array<{ group: ServiceGroupName; from: ServiceTier; to: ServiceTier }> = [];

  for (const [service, deps] of Object.entries(SERVICE_DEPENDENCIES)) {
    const serviceGroup = service as ServiceGroupName;
    const serviceTier = getServiceTier(result, serviceGroup);

    if (serviceTier === 'off') continue;

    for (const dep of deps!) {
      const depTier = getServiceTier(result, dep);
      if (depTier === 'off') {
        promotions.push({ group: dep, from: depTier, to: 'internal' });
        result[dep] = 'internal';
      }
    }
  }

  return { config: result, promotions };
}
