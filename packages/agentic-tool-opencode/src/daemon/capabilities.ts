import type { AgorConfig } from '@agor/core/config';
import { resolveMultiTenancyConfig } from '@agor/core/config';
import { BadRequest } from '@agor/core/feathers';
import type { OpenCodeUnsupportedCode, OpenCodeUnsupportedReason } from '@agor/core/types';

/** The single owner of "can this deployment run OpenCode, and how"; every consumer reads it. */
export type OpenCodeCapabilities =
  | { mode: 'native-file'; unixUserMode: 'simple' | 'sandbox' }
  | { mode: 'managed-projection' }
  | { mode: 'unsupported'; reason: OpenCodeUnsupportedReason };

export type OpenCodeCapabilityConfig = Pick<
  AgorConfig,
  'execution' | 'multi_tenancy' | 'agentic_tools'
>;

const UNSUPPORTED_MESSAGES: Record<OpenCodeUnsupportedCode, string> = {
  hosted_tenancy: 'OpenCode is unavailable in hosted multi-tenant mode.',
  delegated_execution:
    'OpenCode is unavailable in delegated execution mode because the execution substrate does not provide a native-state home boundary.',
  templated_transport: 'OpenCode requires a locally containable executor process.',
  persistent_user_home_required:
    'OpenCode is not available in this workspace: hosted execution requires a persistent per-user executor home.',
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
  if (
    hosted &&
    unixUserMode === 'delegated' &&
    templated &&
    config.agentic_tools?.opencode_hosted_native_state !== 'disabled'
  ) {
    // Checkpoints live in the owner's executor home, so that home must outlive the Job.
    return config.execution?.executor_storage?.user_home === 'persistent-per-user'
      ? { mode: 'managed-projection' }
      : unsupported('persistent_user_home_required');
  }
  if (hosted) return unsupported('hosted_tenancy');
  if (unixUserMode === 'delegated') return unsupported('delegated_execution');
  if (templated) return unsupported('templated_transport');
  return { mode: 'native-file', unixUserMode };
}

export class OpenCodeUnsupportedError extends BadRequest {
  constructor(readonly reason: OpenCodeUnsupportedReason) {
    super(reason.message, { code: reason.code });
    this.name = 'OpenCodeUnsupportedError';
  }
}

/** Resolve a supported mode or throw the structured unsupported reason. */
export function requireOpenCodeSupported(
  config: OpenCodeCapabilityConfig
): Exclude<OpenCodeCapabilities, { mode: 'unsupported' }> {
  const capabilities = resolveOpenCodeCapabilities(config);
  if (capabilities.mode === 'unsupported') throw new OpenCodeUnsupportedError(capabilities.reason);
  return capabilities;
}

/** Require local native-file authority; hosted managed mode has no daemon-side native home. */
export function requireOpenCodeNativeFile(
  config: OpenCodeCapabilityConfig
): Extract<OpenCodeCapabilities, { mode: 'native-file' }> {
  const capabilities = requireOpenCodeSupported(config);
  if (capabilities.mode !== 'native-file') {
    throw new BadRequest('This OpenCode operation is not available in hosted workspaces.');
  }
  return capabilities;
}
