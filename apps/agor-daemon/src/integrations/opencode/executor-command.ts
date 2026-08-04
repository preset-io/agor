import { createOpenCodeExecutorContext } from '@agor/agentic-tool-opencode';
import {
  type RunExecutorCommandOptions,
  startContainedExecutorCommand,
} from '../../utils/spawn-executor.js';

/** Builds the daemon-authorized private envelope for an OpenCode executor operation. */
export function createOpenCodeExecutorInvocation(
  dataHome: string,
  request: Record<string, unknown>
) {
  return {
    command: 'agentic-tool.invoke' as const,
    agenticToolContext: createOpenCodeExecutorContext(dataHome),
    params: {
      tool: 'opencode' as const,
      request,
    },
  };
}

/** Runs one OpenCode auxiliary command behind the daemon's local containment boundary. */
export function startOpenCodeExecutorInvocation(
  dataHome: string,
  request: Record<string, unknown>,
  options: RunExecutorCommandOptions
) {
  return startContainedExecutorCommand(
    createOpenCodeExecutorInvocation(dataHome, request),
    options
  );
}
