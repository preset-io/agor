import type { WorktreeID } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorktreesServiceImpl } from '../../declarations.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

export function registerEnvironmentTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_environment_start
  server.registerTool(
    'agor_environment_start',
    {
      description: 'Start the environment for a worktree by running its configured start command',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const worktreesService = ctx.app.service('worktrees') as unknown as WorktreesServiceImpl;
      try {
        const worktree = await worktreesService.startEnvironment(
          worktreeId as WorktreeID,
          ctx.baseServiceParams
        );
        return textResult({ success: true, worktree });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const commandOutput =
          error instanceof Error
            ? (error as Error & { commandOutput?: string }).commandOutput
            : undefined;
        return textResult({
          success: false,
          error: errorMessage,
          ...(commandOutput ? { output: commandOutput } : {}),
        });
      }
    }
  );

  // Tool 2: agor_environment_stop
  server.registerTool(
    'agor_environment_stop',
    {
      description: 'Stop the environment for a worktree by running its configured stop command',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const worktreesService = ctx.app.service('worktrees') as unknown as WorktreesServiceImpl;
      try {
        const worktree = await worktreesService.stopEnvironment(
          worktreeId as WorktreeID,
          ctx.baseServiceParams
        );
        return textResult({ success: true, worktree });
      } catch (error) {
        return textResult({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );

  // Tool 3: agor_environment_health
  server.registerTool(
    'agor_environment_health',
    {
      description:
        'Check the health status of a worktree environment by running its configured health command. Returns started_at timestamp and uptime_seconds when environment is starting or running.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const worktreesService = ctx.app.service('worktrees') as unknown as WorktreesServiceImpl;
      const worktree = await worktreesService.checkHealth(
        worktreeId as WorktreeID,
        ctx.baseServiceParams
      );
      const envStatus = worktree.environment_instance?.status;
      const isActive = envStatus === 'running' || envStatus === 'starting';
      const startedAt = isActive
        ? (worktree.environment_instance?.process?.started_at ?? null)
        : null;
      let uptimeSeconds: number | null = null;
      if (startedAt) {
        const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
        uptimeSeconds = elapsed >= 0 ? elapsed : null;
      }
      return textResult({
        status: envStatus || 'unknown',
        lastHealthCheck: worktree.environment_instance?.last_health_check,
        started_at: startedAt,
        uptime_seconds: uptimeSeconds,
        worktree,
      });
    }
  );

  // Tool 4: agor_environment_logs
  server.registerTool(
    'agor_environment_logs',
    {
      description: 'Fetch recent logs from a worktree environment (non-streaming, last ~100 lines)',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const worktreesService = ctx.app.service('worktrees') as unknown as WorktreesServiceImpl;
      const logsResult = await worktreesService.getLogs(
        worktreeId as WorktreeID,
        ctx.baseServiceParams
      );
      return textResult(logsResult);
    }
  );

  // Tool 5: agor_environment_open_app
  server.registerTool(
    'agor_environment_open_app',
    {
      description: 'Open the application URL for a worktree environment in the browser',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const worktreesService = ctx.app.service('worktrees') as unknown as WorktreesServiceImpl;
      const worktree = await worktreesService.get(worktreeId as WorktreeID, ctx.baseServiceParams);

      const appUrl = worktree.environment_instance?.access_urls?.[0]?.url;
      if (!appUrl) {
        return textResult({
          success: false,
          error: 'No app URL configured for this worktree',
        });
      }

      return textResult({
        success: true,
        url: appUrl,
        message: `App URL: ${appUrl}`,
      });
    }
  );

  // Tool 6: agor_environment_nuke
  server.registerTool(
    'agor_environment_nuke',
    {
      description:
        'Nuke the environment for a worktree (destructive operation - typically removes volumes and all data)',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const worktreesService = ctx.app.service('worktrees') as unknown as WorktreesServiceImpl;
      try {
        const worktree = await worktreesService.nukeEnvironment(
          worktreeId as WorktreeID,
          ctx.baseServiceParams
        );
        return textResult({
          success: true,
          worktree,
          message: 'Environment nuked successfully - all data and volumes destroyed',
        });
      } catch (error) {
        return textResult({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );
}
