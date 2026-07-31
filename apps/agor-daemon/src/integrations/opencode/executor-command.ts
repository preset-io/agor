import { createOpenCodeExecutorContext } from '@agor/agentic-tool-opencode';

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
