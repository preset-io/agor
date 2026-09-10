import type { AgorConfig } from '@agor/core/config';
import { resolveMultiTenancyConfig } from '@agor/core/config';
import { BadRequest } from '@agor/core/feathers';
import type { OpenCodeUnsupportedCode, OpenCodeUnsupportedReason } from '@agor/core/types';

/**
 * The single owner of "can this deployment run OpenCode, and how".
 *
 * Every consumer (provider settings, model catalog, session creation, tool
 * switch, prompt admission, executor launch, and the UI) reads this resolver
 * instead of re-deriving a guard, so hosted workspaces report one truthful,
 * structured reason and fail closed the same way everywhere. See
 * `context/explorations/opencode-cloud.md` §8.
 */
export type OpenCodeCapabilities =
  | { mode: 'native-file'; unixUserMode: 'simple' | 'sandbox' }
  | { mode: 'managed-projection' }
  | { mode: 'unsupported'; reason: OpenCodeUnsupportedReason };

export type OpenCodeCapabilityConfig = Pick<
  AgorConfig,
  'execution' | 'multi_tenancy' | 'agentic_tools'
>;

const UNSUPPORTED_MESSAGES: Record<OpenCodeUnsupportedCode, string> = {
  hosted_native_state_disabled:
    'OpenCode is not available in this workspace: hosted native-state execution has not been enabled for this deployment.',
  persistent_user_home_required:
    'OpenCode is not available in this workspace: hosted execution requires a persistent per-user executor home.',
  templated_transport:
    'OpenCode is not available in this deployment: its native provider operations require a locally containable executor process, and no hosted execution mode is enabled.',
  delegated_execution:
    'OpenCode is not available in this deployment: delegated execution provides no native-state home boundary, and no hosted execution mode is enabled.',
  hosted_tenancy:
    'OpenCode is not available in this workspace: hosted multi-tenant mode has no daemon-local native-state home, and no hosted execution mode is enabled.',
};

function unsupported(code: OpenCodeUnsupportedCode): OpenCodeCapabilities {
  return { mode: 'unsupported', reason: { code, message: UNSUPPORTED_MESSAGES[code] } };
}

export function resolveOpenCodeCapabilities(
  config: OpenCodeCapabilityConfig
): OpenCodeCapabilities {
  const hosted = resolveMultiTenancyConfig(config).mode === 'required_from_auth';
  const unixUserMode = config.execution?.unix_user_mode ?? 'simple';
  const templated = Boolean(config.execution?.executor_command_template);
  const hostedNativeState = config.agentic_tools?.opencode_hosted_native_state;

  if (hosted || unixUserMode === 'delegated' || templated) {
    if (hostedNativeState !== 'checkpointed') {
      // Report the most specific historical reason so operators of local
      // templated/delegated deployments are not told about tenancy.
      if (hosted) return unsupported('hosted_native_state_disabled');
      return unsupported(
        unixUserMode === 'delegated' ? 'delegated_execution' : 'templated_transport'
      );
    }
    if (!hosted) return unsupported('hosted_tenancy');
    if (unixUserMode !== 'delegated') return unsupported('delegated_execution');
    if (!templated) return unsupported('templated_transport');
    if (config.execution?.executor_storage?.user_home !== 'persistent-per-user') {
      return unsupported('persistent_user_home_required');
    }
    return { mode: 'managed-projection' };
  }

  return { mode: 'native-file', unixUserMode };
}

export class OpenCodeUnsupportedError extends BadRequest {
  constructor(readonly reason: OpenCodeUnsupportedReason) {
    super(reason.message, { code: reason.code });
    this.name = 'OpenCodeUnsupportedError';
  }
}

/**
 * Admit only the listed modes; anything else fails closed with the resolver's
 * structured reason. A mode that exists but is not admitted by this call site
 * is reported as `mode_not_admitted` so the client can tell "never available
 * here" from "not available through this operation".
 */
export function requireOpenCodeMode<
  Mode extends Exclude<OpenCodeCapabilities['mode'], 'unsupported'>,
>(
  capabilities: OpenCodeCapabilities,
  admitted: readonly Mode[],
  operation: string
): Extract<OpenCodeCapabilities, { mode: Mode }> {
  if (capabilities.mode === 'unsupported') throw new OpenCodeUnsupportedError(capabilities.reason);
  if (!(admitted as readonly string[]).includes(capabilities.mode)) {
    throw new BadRequest(`OpenCode ${operation} is not available in ${capabilities.mode} mode.`, {
      code: 'mode_not_admitted',
      mode: capabilities.mode,
    });
  }
  return capabilities as Extract<OpenCodeCapabilities, { mode: Mode }>;
}
