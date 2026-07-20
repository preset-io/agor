/**
 * Schedules MCP tools — first-class CRUD surface for the agor_schedules_*
 * tool family. Mirrors `sessions.ts` shape; six tools per §4.3 of the
 * design doc.
 */

import {
  type Schedule,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  resolveBoardId,
  resolveBranchId,
  resolveScheduleId,
  resolveUserId,
} from '../resolve-ids.js';
import {
  mcpLimit,
  mcpOptionalId,
  mcpOptionalNonEmptyString,
  mcpOptionalNonNegativeInt,
  mcpOptionalString,
  mcpRequiredId,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

const agenticToolConfigSchema = z
  .object({
    agentic_tool: z
      .enum(['claude-code', 'claude-code-cli', 'codex', 'gemini', 'opencode', 'copilot', 'cursor'])
      .describe('Agent to spawn for runs of this schedule.'),
    preset_id: mcpOptionalNonEmptyString(
      'agentic_tool_config.preset_id',
      'Concrete preset UUID. Reserved default references sent by older clients are also accepted.'
    ),
    configuration_reference: z
      .enum([USER_DEFAULT_AGENTIC_CONFIGURATION, WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION])
      .optional()
      .describe('Symbolic user or workspace default to resolve each time the schedule runs.'),
    permission_mode: mcpOptionalString('permission_mode', "Permission mode (e.g., 'auto', 'ask')."),
    model_config: z
      .object({
        mode: z.enum(['alias', 'exact']).optional(),
        model: mcpOptionalString('model_config.model', 'Model name override.'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
        advisorModel: mcpOptionalString(
          'model_config.advisorModel',
          "Claude Code advisor model override (e.g. 'opus', 'sonnet', 'fable')."
        ),
      })
      .optional()
      .describe(
        'Optional model override (canonical DefaultModelConfig shape). Omit to inherit the agent default; set { model } to override; set { mode, model, effort, advisorModel } for full control.'
      ),
    context_files: z
      .array(mcpRequiredString('context_files[]', 'Context file path'))
      .optional()
      .describe('Additional context files to load.'),
  })
  .superRefine((config, ctx) => {
    const hasPreset = config.preset_id !== undefined;
    const hasReference = config.configuration_reference !== undefined;
    const hasInline =
      config.permission_mode !== undefined ||
      config.model_config !== undefined ||
      config.context_files !== undefined;
    if ((hasPreset && hasReference) || ((hasPreset || hasReference) && hasInline)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'agentic_tool_config must use exactly one source: preset_id, configuration_reference, or inline fields.',
      });
    }
  })
  .describe(
    'Agentic-tool configuration. MCP capability selection is configured separately on the schedule.'
  );

export function registerScheduleTools(server: McpServer, ctx: McpContext): void {
  // agor_schedules_list
  server.registerTool(
    'agor_schedules_list',
    {
      description:
        'List schedules accessible to the current user. Filter by branch, board, creator, or enabled status. Returns rows in newest-first order.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        branchId: mcpOptionalId('branchId', 'Branch', 'Filter to schedules on this branch'),
        boardId: mcpOptionalId(
          'boardId',
          'Board',
          'Filter to schedules whose branch belongs to this board'
        ),
        createdBy: mcpOptionalId('createdBy', 'User', 'Filter to schedules created by this user'),
        enabled: z.boolean().optional().describe('Filter by enabled flag'),
        limit: mcpLimit(50).describe('Maximum number of schedules to return (default: 50)'),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.limit) query.$limit = args.limit;
      if (args.branchId) query.branch_id = await resolveBranchId(ctx, args.branchId);
      if (args.createdBy) query.created_by = await resolveUserId(ctx, args.createdBy);
      if (args.enabled !== undefined) query.enabled = args.enabled;
      const result = await ctx.app.service('schedules').find({ query, ...ctx.baseServiceParams });

      // boardId filter is post-query (we'd need a JOIN to do it in SQL);
      // keep it simple — schedule counts per board are small. Resolve
      // short IDs first so a caller can pass either form.
      if (args.boardId) {
        const boardId = await resolveBoardId(ctx, args.boardId);
        const allData: Schedule[] = Array.isArray(result) ? result : result.data;
        const branches = await Promise.all(
          allData.map((s) => ctx.app.service('branches').get(s.branch_id, ctx.baseServiceParams))
        );
        const filtered = allData.filter((_, i) => branches[i]?.board_id === boardId);
        return Array.isArray(result)
          ? textResult(filtered)
          : textResult({ ...result, data: filtered, total: filtered.length });
      }

      return textResult(result);
    }
  );

  // agor_schedules_get
  server.registerTool(
    'agor_schedules_get',
    {
      description:
        'Get a single schedule by ID. Returns full configuration including cron, timezone, agentic_tool_config, last/next run timestamps, and the linked last_run_session_id.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        scheduleId: mcpRequiredId('scheduleId', 'Schedule'),
      }),
    },
    async (args) => {
      const scheduleId = await resolveScheduleId(ctx, args.scheduleId);
      const schedule = await ctx.app.service('schedules').get(scheduleId, ctx.baseServiceParams);
      return textResult(schedule);
    }
  );

  // agor_schedules_create
  server.registerTool(
    'agor_schedules_create',
    {
      description:
        "Create a new schedule on a branch. A branch can hold multiple schedules (e.g. 'hourly heartbeat' + 'daily summary'). Cron + prompt + agentic_tool_config are required.",
      inputSchema: z.strictObject({
        branchId: mcpRequiredId('branchId', 'Branch', 'Branch this schedule belongs to'),
        name: mcpRequiredString('name', "Display name, e.g. 'Hourly heartbeat'"),
        description: mcpOptionalString('description', 'Freeform description'),
        cron_expression: mcpRequiredString(
          'cron_expression',
          "Cron expression (5/6 fields), e.g. '0 9 * * 1-5'"
        ),
        timezone_mode: z
          .enum(['local', 'utc'])
          .describe("'local' uses `timezone`; 'utc' fires in UTC."),
        timezone: mcpOptionalString(
          'timezone',
          "IANA timezone (required when timezone_mode='local'), e.g. 'America/Los_Angeles'"
        ),
        prompt: mcpRequiredString('prompt', 'Handlebars prompt template'),
        agentic_tool_config: agenticToolConfigSchema,
        mcp_server_ids: z
          .array(mcpRequiredId('mcp_server_ids[]', 'MCP server'))
          .optional()
          .describe('MCP servers to attach to spawned sessions.'),
        enabled: z.boolean().optional().describe('Whether to fire (default: true)'),
        allow_concurrent_runs: z
          .boolean()
          .optional()
          .describe(
            'Allow overlapping runs from this schedule (default: false). Sibling schedules on the same branch are independent.'
          ),
        retention: mcpOptionalNonNegativeInt(
          'retention',
          'Number of sessions to keep; 0 = keep all (default: 5)'
        ),
      }),
    },
    async (args) => {
      const branchId = await resolveBranchId(ctx, args.branchId);
      const payload: Partial<Schedule> = {
        branch_id: branchId,
        name: args.name,
        description: args.description,
        cron_expression: args.cron_expression,
        timezone_mode: args.timezone_mode,
        timezone: args.timezone,
        prompt: args.prompt,
        // The zod schema narrows permission_mode/model_config.mode to plain
        // strings; the validator + service hooks coerce them to the
        // canonical enums on save.
        agentic_tool_config: args.agentic_tool_config as Schedule['agentic_tool_config'],
        mcp_server_ids: args.mcp_server_ids,
        enabled: args.enabled,
        allow_concurrent_runs: args.allow_concurrent_runs,
        retention: args.retention,
      };
      const created = await ctx.app.service('schedules').create(payload, ctx.baseServiceParams);
      return textResult(created);
    }
  );

  // agor_schedules_patch
  server.registerTool(
    'agor_schedules_patch',
    {
      description:
        'Patch a schedule. Only the supplied fields are changed; everything else is preserved. Cron / timezone / prompt changes are re-validated.',
      inputSchema: z.strictObject({
        scheduleId: mcpRequiredId('scheduleId', 'Schedule'),
        name: mcpOptionalString('name', 'Display name'),
        description: mcpOptionalString('description', 'Freeform description'),
        cron_expression: mcpOptionalString('cron_expression', 'Cron expression (5/6 fields)'),
        timezone_mode: z.enum(['local', 'utc']).optional(),
        timezone: mcpOptionalString('timezone', 'IANA timezone'),
        prompt: mcpOptionalString('prompt', 'Handlebars prompt template'),
        agentic_tool_config: agenticToolConfigSchema.optional(),
        mcp_server_ids: z.array(mcpRequiredId('mcp_server_ids[]', 'MCP server')).optional(),
        enabled: z.boolean().optional(),
        allow_concurrent_runs: z.boolean().optional(),
        retention: mcpOptionalNonNegativeInt(
          'retention',
          'Number of sessions to keep; 0 = keep all'
        ),
      }),
    },
    async (args) => {
      const { scheduleId: rawId, ...updates } = args;
      const scheduleId = await resolveScheduleId(ctx, rawId);
      const payload = {
        ...updates,
        ...(updates.agentic_tool_config
          ? {
              agentic_tool_config: updates.agentic_tool_config as Schedule['agentic_tool_config'],
            }
          : {}),
      } as Partial<Schedule>;
      const updated = await ctx.app
        .service('schedules')
        .patch(scheduleId, payload, ctx.baseServiceParams);
      return textResult(updated);
    }
  );

  // agor_schedules_delete
  server.registerTool(
    'agor_schedules_delete',
    {
      description:
        'Delete a schedule. Sessions linked via schedule_id are NOT deleted; the FK is SET NULL so historical runs are preserved as orphaned scheduled sessions.',
      annotations: { destructiveHint: true },
      inputSchema: z.strictObject({
        scheduleId: mcpRequiredId('scheduleId', 'Schedule'),
      }),
    },
    async (args) => {
      const scheduleId = await resolveScheduleId(ctx, args.scheduleId);
      await ctx.app.service('schedules').remove(scheduleId, ctx.baseServiceParams);
      return textResult({ success: true, schedule_id: scheduleId });
    }
  );

  // agor_schedules_run_now
  server.registerTool(
    'agor_schedules_run_now',
    {
      description:
        "Trigger a manual run of a schedule. Reuses the cron-tick spawn path so the resulting session is indistinguishable from a scheduled run, except for a 'triggered_manually' marker in custom_context. Requires branch-tier 'all' permission. Returns the new session.",
      inputSchema: z.strictObject({
        scheduleId: mcpRequiredId('scheduleId', 'Schedule'),
      }),
    },
    async (args) => {
      const scheduleId = await resolveScheduleId(ctx, args.scheduleId);
      // Hit the custom REST verb so RBAC + ScheduleBusy / ScheduleNotReady
      // error mapping run through the same code path as the HTTP route.
      const result = await ctx.app
        .service('/schedules/:id/run-now')
        .create({}, { route: { id: scheduleId }, ...ctx.baseServiceParams });
      return textResult(result);
    }
  );
}
