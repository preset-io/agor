import {
  OpenCodeUnsupportedError,
  resolveOpenCodeCapabilities,
} from '@agor/agentic-tool-opencode/daemon';
import type { AgorConfig } from '@agor/core/config';
import type { AgenticToolName } from '@agor/core/types';

/** Shared session-creation gate for interactive and scheduled occurrences. */
export function createDeploymentToolUnsupportedGate(config: AgorConfig) {
  return (tool: AgenticToolName): OpenCodeUnsupportedError | undefined => {
    if (tool !== 'opencode') return undefined;
    const capabilities = resolveOpenCodeCapabilities(config);
    return capabilities.mode === 'unsupported'
      ? new OpenCodeUnsupportedError(capabilities.reason)
      : undefined;
  };
}
