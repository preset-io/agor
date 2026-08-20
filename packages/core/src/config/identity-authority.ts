import {
  type AgorConfig,
  AgorExternalIdentityProvider,
  AgorExternalIdentityProvisioning,
  AgorLocalAuthMode,
  AgorRoleAuthority,
  AgorUserLifecycleAuthority,
  IDENTITY_AUTHORITY_CONTRACT_VERSION,
  type ResolvedIdentityAuthority,
} from './types';

/** Resolve the omitted-config local default into one transport-neutral policy. */
export function resolveIdentityAuthority(config: AgorConfig): ResolvedIdentityAuthority {
  const userLifecycle = config.identity?.user_lifecycle ?? AgorUserLifecycleAuthority.INTERNAL;
  const roleAuthority = config.identity?.role_authority ?? AgorRoleAuthority.INTERNAL;
  const localAuth = config.identity?.local_auth ?? AgorLocalAuthMode.ENABLED;
  const externallyManaged = userLifecycle === AgorUserLifecycleAuthority.EXTERNAL;
  const external = config.identity?.external;

  return {
    contractVersion: IDENTITY_AUTHORITY_CONTRACT_VERSION,
    userLifecycle,
    roleAuthority,
    localAuth,
    ...(external?.provider === AgorExternalIdentityProvider.EXTERNAL_LAUNCH &&
    external.provisioning === AgorExternalIdentityProvisioning.JIT
      ? {
          external: {
            provider: external.provider,
            provisioning: external.provisioning,
          },
        }
      : {}),
    capabilities: {
      users: {
        create: !externallyManaged,
        delete: !externallyManaged,
        identityWrite: !externallyManaged,
        roleWrite: roleAuthority === AgorRoleAuthority.INTERNAL,
        passwordWrite: localAuth === AgorLocalAuthMode.ENABLED && !externallyManaged,
        avatarSettingsWrite: !externallyManaged,
        selfConfigurationWrite: true,
      },
    },
  };
}

function externalLaunchEnabled(config: AgorConfig, env: NodeJS.ProcessEnv): boolean {
  const override = env.AGOR_EXTERNAL_LAUNCH_ENABLED?.trim().toLowerCase();
  if (override !== undefined && override !== '') {
    return ['1', 'true', 'yes', 'on'].includes(override);
  }
  return config.external_launch?.enabled === true;
}

/**
 * Validate the resolved authority profile before database initialization.
 * Invalid partial profiles fail closed rather than producing combinations
 * whose create, role, password, and JIT behavior disagree.
 */
export function assertValidEffectiveIdentityConfig(
  config: AgorConfig,
  env: NodeJS.ProcessEnv = process.env
): void {
  const identity = config.identity;
  if (!identity) return;

  const resolved = resolveIdentityAuthority(config);
  if (resolved.userLifecycle === AgorUserLifecycleAuthority.INTERNAL) {
    if (resolved.roleAuthority !== AgorRoleAuthority.INTERNAL) {
      throw new Error(
        "identity.role_authority 'claims' requires identity.user_lifecycle 'external'"
      );
    }
    if (resolved.localAuth !== AgorLocalAuthMode.ENABLED) {
      throw new Error("identity.local_auth 'disabled' requires identity.user_lifecycle 'external'");
    }
    if (identity.external !== undefined) {
      throw new Error('identity.external is only valid when identity.user_lifecycle is external');
    }
    return;
  }

  if (resolved.roleAuthority !== AgorRoleAuthority.CLAIMS) {
    throw new Error("identity.user_lifecycle 'external' requires identity.role_authority 'claims'");
  }
  if (resolved.localAuth !== AgorLocalAuthMode.DISABLED) {
    throw new Error("identity.user_lifecycle 'external' requires identity.local_auth 'disabled'");
  }
  if (
    identity.external?.provider !== AgorExternalIdentityProvider.EXTERNAL_LAUNCH ||
    identity.external.provisioning !== AgorExternalIdentityProvisioning.JIT
  ) {
    throw new Error(
      "identity.user_lifecycle 'external' requires identity.external.provider 'external_launch' and provisioning 'jit'"
    );
  }
  if (!externalLaunchEnabled(config, env)) {
    throw new Error(
      'identity external authority requires external_launch.enabled or AGOR_EXTERNAL_LAUNCH_ENABLED'
    );
  }
  if ((config.execution?.bootstrap_superadmin_users?.length ?? 0) > 0) {
    throw new Error(
      'execution.bootstrap_superadmin_users is incompatible with claim-authoritative roles'
    );
  }
}
