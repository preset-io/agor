/**
 * Widgets MCP Tools — agent-facing tools for in-conversation widget primitives.
 *
 * v1 ships a single tool: `agor_widgets_request_env_vars`. The widget is
 * fire-and-forget: this handler returns immediately with `{ widget_id, status }`
 * and the agent ends its turn. When the user types values into the inline
 * form and hits "Save & continue", the daemon writes them, queues a system-
 * authored auto-resume prompt via the existing `/sessions/:id/prompt` route,
 * and the agent picks up where it left off in its next turn.
 *
 * Security contract (§5.1 of the design doc): the agent never sees submitted
 * values. The tool input only accepts variable NAMES; the values reach the
 * daemon directly from the browser via `POST /widgets/:widget_id/submit`.
 *
 * See `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 */

import type {
  EnvVarMetadata,
  EnvVarScope,
  MessageID,
  Session,
  SessionID,
  User,
  UserID,
  WidgetMessageMetadata,
} from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appendSystemMessage } from '../../utils/append-system-message.js';
import { type EnvVarsParams, envVarsParamsSchema } from '../../widgets/env-vars/index.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

/**
 * Build a short, user-visible message body for the widget transcript row.
 * Falls back to a generic phrasing when there's only one or many names; agents
 * rarely look at this string but it's what shows above the form.
 */
function widgetContentPreview(params: EnvVarsParams): string {
  const list = params.names.join(', ');
  return params.names.length === 1
    ? `Please provide ${list}: ${params.reason}`
    : `Please provide ${list}: ${params.reason}`;
}

/**
 * Check whether the user already has ALL requested names set in the chosen
 * scope. The `already_present` short-circuit (D4 in the design doc) fires
 * when this returns true.
 */
function allNamesPresentInScope(
  envVarsMeta: Record<string, EnvVarMetadata> | undefined,
  names: string[],
  scope: EnvVarScope
): boolean {
  if (!envVarsMeta) return false;
  for (const name of names) {
    const meta = envVarsMeta[name];
    if (!meta || meta.scope !== scope) return false;
  }
  return true;
}

export function registerWidgetTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_widgets_request_env_vars',
    {
      description:
        'Ask the user to provide one or more environment variables via an in-conversation form. ' +
        'This is a FIRE-AND-FORGET request: the widget is rendered inline in the transcript and the user fills it out asynchronously. ' +
        'End your turn after this tool call — you will receive a new user-role message ("[Agor] User submitted ...") when the user responds, and can resume work then. ' +
        'CRITICAL: the values never enter your context — the user types them directly into the UI, the form posts straight to the daemon, and you only ever see variable NAMES. ' +
        'Use this when you need a secret/credential to proceed (e.g. an API key). Do NOT ask the user to paste the value into chat — that defeats the security guarantee.',
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: envVarsParamsSchema,
    },
    async (args) => {
      // Validated by Zod via the SDK; `args` has Zod defaults applied.
      const params: EnvVarsParams = args as EnvVarsParams;

      // Look up the host session + its creator. The session creator is the
      // identity whose env vars get written and read by the executor — this
      // matches the `dangerously_allow_session_sharing: false` semantics.
      const session = (await ctx.app
        .service('sessions')
        .get(ctx.sessionId, ctx.baseServiceParams)) as Session;
      const sessionCreatorId = session.created_by as UserID;
      const creator = (await ctx.app
        .service('users')
        .get(sessionCreatorId, ctx.baseServiceParams)) as User;

      // `already_present` short-circuit: if every requested name is already
      // set in the chosen default scope, skip the form entirely and auto-
      // resume the agent with a "use what you have" prompt.
      const presentEverywhere = allNamesPresentInScope(
        creator.env_vars,
        params.names,
        params.default_scope as EnvVarScope
      );

      const requestedAt = new Date().toISOString();
      const baseWidgetMeta: Omit<WidgetMessageMetadata, 'widget_id'> = {
        widget_type: 'env_vars',
        schema_version: 1,
        params,
        status: presentEverywhere ? 'already_present' : 'pending',
        requested_at: requestedAt,
        ...(presentEverywhere ? { resolved_at: requestedAt } : {}),
        auto_resume: params.auto_resume,
      };

      const created = await appendSystemMessage({
        app: ctx.app,
        db: ctx.db,
        sessionId: ctx.sessionId,
        content: widgetContentPreview(params),
        contentPreview: `Widget: env_vars (${params.names.join(', ')})`,
        type: 'widget_request',
        role: MessageRole.SYSTEM,
        // widget_id is filled in once we know the new message_id (id == widget_id).
        metadata: {
          widget: {
            ...baseWidgetMeta,
            widget_id: 'pending' as MessageID,
          },
        },
      });

      const widgetId = created.message_id as MessageID;

      // Stamp the actual widget_id onto the row (single source of truth =
      // `metadata.widget.widget_id === message.message_id`).
      await ctx.app.service('messages').patch(
        widgetId,
        {
          metadata: {
            ...(created.metadata ?? {}),
            widget: { ...baseWidgetMeta, widget_id: widgetId },
          },
        },
        ctx.baseServiceParams
      );

      if (presentEverywhere) {
        // Short-circuit: no form render. Auto-queue a "values already
        // configured" task (unless the agent opted out via auto_resume:false).
        if (params.auto_resume) {
          const namesList = params.names.join(', ');
          const verb = params.names.length === 1 ? 'was' : 'were';
          const prompt = `[Agor] ${namesList} ${verb} already configured. You can proceed.`;
          await ctx.app.service('/sessions/:id/prompt').create(
            {
              prompt,
              messageSource: 'agor',
              metadata: {
                system_authored: true,
                widget_id: widgetId,
              },
            },
            { ...ctx.baseServiceParams, route: { id: ctx.sessionId as SessionID } }
          );
        }
        return textResult({ widget_id: widgetId, status: 'already_present' });
      }

      return textResult({ widget_id: widgetId, status: 'requested' });
    }
  );
}
