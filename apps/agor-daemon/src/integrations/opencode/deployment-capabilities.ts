import {
  type OpenCodeCapabilityConfig,
  OpenCodeUnsupportedError,
  resolveOpenCodeCapabilities,
} from '@agor/agentic-tool-opencode/daemon';
import type { AgenticToolName, DeepReadonly } from '@agor/core/types';

/** Shared session-creation gate for interactive and scheduled occurrences. */
export function createDeploymentToolUnsupportedGate(
  config: DeepReadonly<OpenCodeCapabilityConfig>
) {
  return (tool: AgenticToolName): OpenCodeUnsupportedError | undefined => {
    if (tool !== 'opencode') return undefined;
    const capabilities = resolveOpenCodeCapabilities(config);
    return capabilities.mode === 'unsupported'
      ? new OpenCodeUnsupportedError(capabilities.reason)
      : undefined;
  };
}
