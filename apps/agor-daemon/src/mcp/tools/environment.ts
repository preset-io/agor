import type { BranchID } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BranchesServiceImpl, ReposServiceImpl } from '../../declarations.js';
import { mcpOptionalString, mcpRequiredId } from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';
import { assertValidVariant } from './_environment-helpers.js';

export function registerEnvironmentTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_environment_start
  server.registerTool(
    'agor_environment_start',
    {
      description:
        'Start the environment for a branch using its configured start action (shell command by default, or HTTP(S) GET webhook when URL-shaped / webhook-only mode)',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
      }),
    },
    async (args) => {
      const branchId = coerceString(args.branchId)!;
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;
      try {
        const branch = await branchesService.startEnvironment(
          branchId as BranchID,
          ctx.baseServiceParams
        );
        return textResult({ success: true, branch });
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
      description:
        'Stop the environment for a branch using its configured stop action (shell command by default, or HTTP(S) GET webhook when URL-shaped / webhook-only mode)',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
      }),
    },
    async (args) => {
      const branchId = coerceString(args.branchId)!;
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;
      try {
        const branch = await branchesService.stopEnvironment(
          branchId as BranchID,
          ctx.baseServiceParams
        );
        return textResult({ success: true, branch });
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
        'Check the health status of a branch environment by running its configured health command. Returns started_at timestamp and uptime_seconds when environment is starting or running.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
      }),
    },
    async (args) => {
      const branchId = coerceString(args.branchId)!;
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;
      const branch = await branchesService.checkHealth(branchId as BranchID, ctx.baseServiceParams);
      const envStatus = branch.environment_instance?.status;
      const isActive = envStatus === 'running' || envStatus === 'starting';
      const startedAt = isActive
        ? (branch.environment_instance?.process?.started_at ?? null)
        : null;
      let uptimeSeconds: number | null = null;
      if (startedAt) {
        const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
        uptimeSeconds = elapsed >= 0 ? elapsed : null;
      }
      return textResult({
        status: envStatus || 'unknown',
        lastHealthCheck: branch.environment_instance?.last_health_check,
        started_at: startedAt,
        uptime_seconds: uptimeSeconds,
        branch,
      });
    }
  );

  // Tool 4: agor_environment_logs
  server.registerTool(
    'agor_environment_logs',
    {
      description:
        'Fetch recent logs from a branch environment (non-streaming, last ~100 lines; shell command by default, or HTTP(S) GET webhook when URL-shaped / webhook-only mode)',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
      }),
    },
    async (args) => {
      const branchId = coerceString(args.branchId)!;
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;
      const logsResult = await branchesService.getLogs(branchId as BranchID, ctx.baseServiceParams);
      return textResult(logsResult);
    }
  );

  // Tool 5: agor_environment_open_app
  server.registerTool(
    'agor_environment_open_app',
    {
      description: 'Open the application URL for a branch environment in the browser',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
      }),
    },
    async (args) => {
      const branchId = coerceString(args.branchId)!;
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;
      const branch = await branchesService.get(branchId as BranchID, ctx.baseServiceParams);

      const appUrl = branch.environment_instance?.access_urls?.[0]?.url;
      if (!appUrl) {
        return textResult({
          success: false,
          error: 'No app URL configured for this branch',
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
  // Configuration verb: persists the variant on the branch and re-renders
  // the materialized command strings (start/stop/nuke/logs/health/app) from
  // the repo's Handlebars templates. `start`, `stop`, `restart`, `logs`, etc.
  // always operate on the persisted variant — they don't take a variant arg —
  // so swapping the variant is an explicit, visible step rather than a side
  // effect of an "execute" verb.
  server.registerTool(
    'agor_environment_set',
    {
      description:
        "Set the environment variant for a branch and persist it. Re-renders the branch's " +
        'environment commands (start/stop/nuke/logs/health/app) from the repo config so subsequent ' +
        'agor_environment_start/stop/etc. operate on the new variant. ' +
        'Variant changes require admin permission (rendered commands run as the system user). ' +
        'Refuses to switch variant when the environment is running or starting — stop it first. ' +
        'Pass andStart=true to start the environment after setting; otherwise call agor_environment_start separately. ' +
        'Omit variant to re-render the branch with its current variant (useful for picking up template_overrides changes).',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
        variant: mcpOptionalString(
          'variant',
          'Environment variant name to set. Must be a key in the repo environment config variants. ' +
            "When omitted, re-renders using the branch's current variant (or the repo default if unset)."
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
      const branchId = coerceString(args.branchId)!;
      const variant = coerceString(args.variant);
      const andStart = args.andStart === true;
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;

      try {
        const branch = await branchesService.get(branchId as BranchID, ctx.baseServiceParams);

        // Resolve the target variant: caller-supplied wins, otherwise re-render
        // with the branch's current variant. We only fall through to
        // `undefined` (which lets the service apply the repo default) when the
        // branch has no variant set at all — the legacy first-render case.
        // Without this fallback, omitting `variant` would silently flip a
        // branch from a non-default variant back to the repo default.
        const targetVariant = variant ?? branch.environment_variant ?? undefined;

        if (variant) {
          const reposService = ctx.app.service('repos') as unknown as ReposServiceImpl;
          const repo = await reposService.get(branch.repo_id);
          assertValidVariant(repo, variant);
        }

        // The "variant change while env is running/starting" guard lives in
        // BranchesService.renderEnvironment so it covers REST/UI/MCP
        // uniformly. The error it throws is propagated by the outer catch
        // below.

        const updated = await branchesService.renderEnvironment(
          branchId as BranchID,
          targetVariant ? { variant: targetVariant } : undefined,
          ctx.baseServiceParams
        );

        if (!andStart) {
          return textResult({
            success: true,
            branch: updated,
            message: `Environment variant set to "${updated.environment_variant}".`,
          });
        }

        // The variant has now been persisted. If start fails, surface that
        // distinctly so callers know the configuration change DID land.
        try {
          const started = await branchesService.startEnvironment(
            branchId as BranchID,
            ctx.baseServiceParams
          );
          return textResult({
            success: true,
            branch: started,
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
            branch: updated,
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
        'Nuke the environment for a branch (destructive operation - typically removes volumes and all data; shell command by default, or HTTP(S) GET webhook when URL-shaped / webhook-only mode)',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
      }),
    },
    async (args) => {
      const branchId = coerceString(args.branchId)!;
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;
      try {
        const branch = await branchesService.nukeEnvironment(
          branchId as BranchID,
          ctx.baseServiceParams
        );
        return textResult({
          success: true,
          branch,
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
