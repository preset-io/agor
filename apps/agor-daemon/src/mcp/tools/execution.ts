import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type McpContext, textResult } from '../server.js';

export function registerExecutionTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_execution_get_current',
    {
      description:
        'Return fresh token-bound execution, task, session, branch and tenant identity. Requires a live executor-derived MCP credential; personal API keys, session headers and ordinary session tokens cannot attest execution. Rechecks current task authority and revocation. Grants no review, posting or dispatch rights.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const identity = await ctx.getExecutionIdentity?.();
      return identity
        ? textResult(identity)
        : {
            ...textResult({
              status: 'unavailable',
              reason_code: 'EXECUTOR_TASK_IDENTITY_REQUIRED',
            }),
            isError: true,
          };
    }
  );
}
