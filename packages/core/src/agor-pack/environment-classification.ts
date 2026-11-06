/**
 * Classify a repository's environment variants for a move into Agor Cloud.
 * Cloud runs shell lifecycle commands as short ephemeral jobs with no Docker
 * socket, no ingress, and no long-lived processes, so container tooling,
 * private-network endpoints, and host service managers will not work there. The
 * configuration is imported unchanged; this only drives warnings.
 */

import { resolveVariant } from '../config/variant-resolver';
import { isUrlShapedManagedEnvCommand } from '../environment/webhook';
import { type AgorPackEnvironmentStatus, agorPackPrivateHost } from '../types/agor-pack';
import type { RepoEnvironment } from '../types/branch';

const WONT_RUN = /\b(docker(-compose)?|podman|compose|sudo|systemctl|launchctl|brew services)\b/i;

export interface EnvironmentVariantClassification {
  name: string;
  status: AgorPackEnvironmentStatus;
  match: string | null;
}

export function classifyEnvironmentVariants(
  environment: RepoEnvironment | null | undefined
): EnvironmentVariantClassification[] {
  if (environment?.version !== 2 || !environment.variants) return [];
  return Object.keys(environment.variants)
    .sort()
    .map((name) => {
      const variant = resolveVariant(environment, name);
      if (!variant) return { name, status: 'ok' as const, match: null };
      const lifecycle = [variant.start, variant.stop, variant.nuke, variant.logs].filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      );
      for (const command of lifecycle) {
        if (isUrlShapedManagedEnvCommand(command)) continue;
        const hit = WONT_RUN.exec(command);
        if (hit) return { name, status: 'wont_run_in_cloud' as const, match: hit[0] };
      }
      for (const value of [...lifecycle, variant.health, variant.app]) {
        const host = typeof value === 'string' ? agorPackPrivateHost(value) : null;
        if (host) return { name, status: 'needs_webhook' as const, match: host };
      }
      return { name, status: 'ok' as const, match: null };
    });
}
