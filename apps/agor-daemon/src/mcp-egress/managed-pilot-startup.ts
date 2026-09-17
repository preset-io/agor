import { type AgorConfig, validateManagedMCPOAuthConfig } from '@agor/core/config';
import {
  McpOAuthFreshPilotEnrollmentSchema,
  mcpOAuthFreshPilotRuntimeConfigDigest,
} from '@agor/core/types';
import { z } from 'zod';
import { ManagedDeploymentError } from './managed-deployment-files.js';

/**
 * Capture the validated, immutable configuration SOURCE before startup injects
 * secrets/environment overrides or generates diagnostic identities. The pilot
 * admission policy must independently pin the complete environment/SecretRefs,
 * image and mounts. This digest is not a claim about resolved secret values.
 * No request, session or tenant-selected input may call this startup boundary.
 */
export function captureManagedOAuthPilotStartup(
  config: AgorConfig,
  environment: { AGOR_DAEMON_INSTANCE_ID?: string; AGOR_POD_NAMESPACE?: string }
): Readonly<{ podUid: string; podNamespace: string; runtimeConfigDigest: string }> | undefined {
  if (
    config.managed_mcp_oauth?.enabled !== true ||
    config.managed_mcp_oauth.fresh_pilot_enrollment_sha256 === undefined
  )
    return undefined;
  try {
    validateManagedMCPOAuthConfig(config.managed_mcp_oauth);
    return Object.freeze({
      podUid: z.uuid().parse(environment.AGOR_DAEMON_INSTANCE_ID),
      podNamespace: McpOAuthFreshPilotEnrollmentSchema.shape.namespace.parse(
        environment.AGOR_POD_NAMESPACE
      ),
      runtimeConfigDigest: mcpOAuthFreshPilotRuntimeConfigDigest(config),
    });
  } catch {
    throw new ManagedDeploymentError();
  }
}
