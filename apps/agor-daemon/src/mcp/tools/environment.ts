import type { BranchEnvironmentCommandOverrides, BranchID } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { BranchesServiceImpl, ReposServiceImpl } from '../../declarations.js';
import { mcpOptionalNonBlankString, mcpOptionalString, mcpRequiredId } from '../schema.js';
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
        return textResult({
          success: true,
          branch,
          message:
            'Environment start requested. Poll agor_environment_health and agor_environment_logs for readiness, progress, or failures.',
        });
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
        return textResult({
          success: true,
          branch,
          message:
            'Environment stop requested. Poll agor_environment_health for final status and agor_environment_logs for command output.',
        });
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
        'Read a branch environment health status. Starting/running environments run the configured HTTP health probe; inactive environments are not restarted or enrolled in monitoring. Returns started_at and uptime_seconds while active.',
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
        'Fetch recent logs from a branch environment (non-streaming, last ~500 lines; shell command by default, or HTTP(S) GET webhook when URL-shaped / webhook-only mode)',
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
        'Variant changes require effective branch `all` permission or admin access. ' +
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
          const repo = await reposService.get(branch.repo_id, ctx.baseServiceParams);
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
            message:
              `Environment variant set to "${updated.environment_variant}" and start requested. ` +
              'Poll agor_environment_health and agor_environment_logs for readiness, progress, or failures.',
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

  // Tool 7: agor_environment_set_commands
  // Configuration verb: writes raw command strings straight onto the branch as
  // per-branch overrides (the programmatic equivalent of editing the branch
  // "snapshot" in the Environment settings tab). Unlike agor_environment_set,
  // which SELECTS a vetted variant and re-renders from the repo config, this
  // sets arbitrary executable commands — so it is admin-only.
  server.registerTool(
    'agor_environment_set_commands',
    {
      description:
        "Set some or all of a branch's environment commands directly, then persist them so " +
        'agor_environment_start/stop/health/logs/nuke/open_app use them. Provide any subset of ' +
        'start, stop, nuke, logs (shell commands, or http(s) URLs to invoke as GET webhooks) and ' +
        'health, app (http(s) URLs). Omitted fields keep their current value; to reset a field ' +
        'back to the repo/variant default, use agor_environment_set to re-render instead. ' +
        'Lets an agent apply the dev commands it discovered from a repo without a trip to Settings. ' +
        'Requires ADMIN access: these strings execute as the system user, so branch `all` ' +
        'permission alone is not sufficient (that tier only selects a vetted variant). ' +
        'Refuses to change commands while the environment is running or starting — stop it first. ' +
        'Pass andStart=true to start the environment after setting; otherwise call ' +
        'agor_environment_start separately. Returns the resulting effective command set.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
        start: mcpOptionalNonBlankString(
          'start',
          'Start command (shell string, or an http(s) URL invoked as a GET webhook).'
        ),
        stop: mcpOptionalNonBlankString(
          'stop',
          'Stop command (shell string, or an http(s) URL invoked as a GET webhook).'
        ),
        nuke: mcpOptionalNonBlankString(
          'nuke',
          'Destructive reset command (shell string, or an http(s) URL invoked as a GET webhook).'
        ),
        logs: mcpOptionalNonBlankString(
          'logs',
          'Recent-logs command (shell string, or an http(s) URL invoked as a GET webhook).'
        ),
        health: mcpOptionalNonBlankString(
          'health',
          'Health check http(s) URL (may target localhost / branch-local services).'
        ),
        app: mcpOptionalNonBlankString(
          'app',
          'Application http(s) URL for the running environment.'
        ),
        andStart: z
          .boolean()
          .optional()
          .describe(
            'When true, start the environment after setting the commands. Defaults to false. ' +
              'Convenience for one-shot configure-and-run workflows.'
          ),
      }),
    },
    async (args) => {
      const branchId = coerceString(args.branchId)!;
      const andStart = args.andStart === true;
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;

      const overrides: BranchEnvironmentCommandOverrides = {};
      const start = coerceString(args.start);
      const stop = coerceString(args.stop);
      const nuke = coerceString(args.nuke);
      const logs = coerceString(args.logs);
      const health = coerceString(args.health);
      const app = coerceString(args.app);
      if (start !== undefined) overrides.start = start;
      if (stop !== undefined) overrides.stop = stop;
      if (nuke !== undefined) overrides.nuke = nuke;
      if (logs !== undefined) overrides.logs = logs;
      if (health !== undefined) overrides.health = health;
      if (app !== undefined) overrides.app = app;

      const effectiveCommands = (branch: {
        start_command?: string;
        stop_command?: string;
        nuke_command?: string;
        logs_command?: string;
        health_check_url?: string;
        app_url?: string;
      }) => ({
        start: branch.start_command ?? null,
        stop: branch.stop_command ?? null,
        nuke: branch.nuke_command ?? null,
        logs: branch.logs_command ?? null,
        health: branch.health_check_url ?? null,
        app: branch.app_url ?? null,
      });

      try {
        const updated = await branchesService.setEnvironmentCommands(
          branchId as BranchID,
          overrides,
          ctx.baseServiceParams
        );

        if (!andStart) {
          return textResult({
            success: true,
            branch: updated,
            commands: effectiveCommands(updated),
            message: 'Environment commands updated.',
          });
        }

        // Commands are persisted. If start fails, surface that distinctly so
        // callers know the configuration change DID land.
        try {
          const started = await branchesService.startEnvironment(
            branchId as BranchID,
            ctx.baseServiceParams
          );
          return textResult({
            success: true,
            branch: started,
            commands: effectiveCommands(started),
            message:
              'Environment commands updated and start requested. ' +
              'Poll agor_environment_health and agor_environment_logs for readiness, progress, or failures.',
          });
        } catch (startError) {
          const startMessage = startError instanceof Error ? startError.message : 'Unknown error';
          const commandOutput =
            startError instanceof Error
              ? (startError as Error & { commandOutput?: string }).commandOutput
              : undefined;
          return textResult({
            success: false,
            commands_set: true,
            branch: updated,
            commands: effectiveCommands(updated),
            error: `Commands were updated, but start failed: ${startMessage}`,
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

  // Tool 8: agor_environment_nuke
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
          message:
            'Environment nuke requested. Poll agor_environment_health for final status and agor_environment_logs for command output.',
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
