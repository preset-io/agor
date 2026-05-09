import type { WorktreeID } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ReposServiceImpl, WorktreesServiceImpl } from '../../declarations.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';
import { assertValidVariant } from './_environment-helpers.js';

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

  // Tool 6: agor_environment_set
  // Configuration verb: persists the variant on the worktree and re-renders
  // the materialized command strings (start/stop/nuke/logs/health/app) from
  // the repo's Handlebars templates. `start`, `stop`, `restart`, `logs`, etc.
  // always operate on the persisted variant — they don't take a variant arg —
  // so swapping the variant is an explicit, visible step rather than a side
  // effect of an "execute" verb.
  server.registerTool(
    'agor_environment_set',
    {
      description:
        "Set the environment variant for a worktree and persist it. Re-renders the worktree's " +
        'environment commands (start/stop/nuke/logs/health/app) from the repo config so subsequent ' +
        'agor_environment_start/stop/etc. operate on the new variant. ' +
        'Variant changes require admin permission (rendered commands run as the system user). ' +
        'Refuses to switch variant when the environment is running or starting — stop it first. ' +
        'Pass andStart=true to start the environment after setting; otherwise call agor_environment_start separately. ' +
        'Omit variant to re-render the worktree with its current variant (useful for picking up template_overrides changes).',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID (UUIDv7 or short ID)'),
        variant: z
          .string()
          .optional()
          .describe(
            'Environment variant name to set. Must be a key in the repo environment config variants. ' +
              "When omitted, re-renders using the worktree's current variant (or the repo default if unset)."
          ),
        andStart: z
          .boolean()
          .optional()
          .describe(
            'When true, start the environment after setting the variant. Defaults to false. ' +
              'Convenience for one-shot configure-and-run workflows.'
          ),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const variant = coerceString(args.variant);
      const andStart = args.andStart === true;
      const worktreesService = ctx.app.service('worktrees') as unknown as WorktreesServiceImpl;

      try {
        const worktree = await worktreesService.get(
          worktreeId as WorktreeID,
          ctx.baseServiceParams
        );

        // Resolve the target variant: caller-supplied wins, otherwise re-render
        // with the worktree's current variant. We only fall through to
        // `undefined` (which lets the service apply the repo default) when the
        // worktree has no variant set at all — the legacy first-render case.
        // Without this fallback, omitting `variant` would silently flip a
        // worktree from a non-default variant back to the repo default.
        const targetVariant = variant ?? worktree.environment_variant ?? undefined;

        if (variant) {
          const reposService = ctx.app.service('repos') as unknown as ReposServiceImpl;
          const repo = await reposService.get(worktree.repo_id);
          assertValidVariant(repo, variant);
        }

        // The "variant change while env is running/starting" guard lives in
        // WorktreesService.renderEnvironment so it covers REST/UI/MCP
        // uniformly. The error it throws is propagated by the outer catch
        // below.

        const updated = await worktreesService.renderEnvironment(
          worktreeId as WorktreeID,
          targetVariant ? { variant: targetVariant } : undefined,
          ctx.baseServiceParams
        );

        if (!andStart) {
          return textResult({
            success: true,
            worktree: updated,
            message: `Environment variant set to "${updated.environment_variant}".`,
          });
        }

        // The variant has now been persisted. If start fails, surface that
        // distinctly so callers know the configuration change DID land.
        try {
          const started = await worktreesService.startEnvironment(
            worktreeId as WorktreeID,
            ctx.baseServiceParams
          );
          return textResult({
            success: true,
            worktree: started,
            message: `Environment variant set to "${updated.environment_variant}" and started.`,
          });
        } catch (startError) {
          const startMessage = startError instanceof Error ? startError.message : 'Unknown error';
          const commandOutput =
            startError instanceof Error
              ? (startError as Error & { commandOutput?: string }).commandOutput
              : undefined;
          return textResult({
            success: false,
            variant_set: true,
            worktree: updated,
            error: `Variant was set to "${updated.environment_variant}", but start failed: ${startMessage}`,
            ...(commandOutput ? { output: commandOutput } : {}),
          });
        }
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

  // Tool 7: agor_environment_nuke
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
