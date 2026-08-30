import { filterEnv } from '@agor/core/config';

const PAYLOAD_IDENTITY_DENY = new Set([
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'AGOR_MASTER_SECRET',
]);

function isDeniedPayloadEnvironmentName(key: string): boolean {
  const upper = key.toUpperCase();
  return PAYLOAD_IDENTITY_DENY.has(upper) || upper.startsWith('LD_') || upper.startsWith('DYLD_');
}

export interface AppliedPromptPayloadEnvironment {
  applied: string[];
  rejected: string[];
  identityDenied: string[];
}

/**
 * Apply the authenticated prompt payload's environment without replacing
 * process identity or dynamic-loader controls owned by the execution pod.
 *
 * This is the final executor-side process-environment boundary. The daemon
 * still validates maps before launch, but delegated/imported payloads must not
 * be able to replace the substrate's HOME or loader policy.
 */
export function applyPromptPayloadEnvironment(
  payloadEnv: Record<string, string>,
  target: NodeJS.ProcessEnv = process.env,
  onRejected?: (key: string) => void
): AppliedPromptPayloadEnvironment {
  const { env: safeEnv, rejected } = filterEnv(payloadEnv, onRejected);
  const applied: string[] = [];
  const identityDenied: string[] = [];

  for (const [key, value] of Object.entries(safeEnv)) {
    if (isDeniedPayloadEnvironmentName(key)) {
      identityDenied.push(key);
      continue;
    }
    target[key] = value;
    applied.push(key);
  }

  return { applied, rejected, identityDenied };
}
