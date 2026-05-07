/**
 * Shared zone-trigger orchestration.
 *
 * `fireAlwaysNewZoneTrigger()` runs the always_new flow end-to-end:
 *   render template → validate non-empty → resolve session defaults →
 *   create session → attach MCP servers → send prompt.
 *
 * Both `POST /worktrees/:id/fire-zone-trigger` (UI path) and
 * `agor_worktrees_set_zone(triggerTemplate: true)` always_new branch (MCP
 * path) call this helper so they stay in lockstep — same render context,
 * same session-defaults resolution, same MCP-attach behaviour.
 */

import { resolveSessionDefaults } from '@agor/core/sessions';
import { renderTemplate } from '@agor/core/templates/handlebars-helpers';
import { buildZoneTriggerContext } from '@agor/core/templates/zone-trigger-context';
import type { AgenticToolName, Session, Task, User, Worktree } from '@agor/core/types';

export interface FireAlwaysNewZoneTriggerInput {
  // biome-ignore lint/suspicious/noExplicitAny: Feathers app type varies across callers
  app: any;
  // biome-ignore lint/suspicious/noExplicitAny: Feathers params shape varies across callers
  params: any;
  worktree: Worktree;
  board: { name?: string; description?: string; custom_context?: Record<string, unknown> };
  zone: {
    label?: string;
    status?: string;
    trigger?: { template?: string; agent?: AgenticToolName; behavior?: string };
  };
  user: User;
  /** Caller's userId; stored on the new session as `created_by`. */
  userId: string;
}

export interface FireAlwaysNewZoneTriggerResult {
  session: Session;
  task: Task;
}

const VALID_AGENTS: AgenticToolName[] = ['claude-code', 'codex', 'gemini', 'opencode'];

/**
 * Run the full always_new zone-trigger flow against an already-fetched
 * worktree/board/zone/user tuple. Returns the new session + its first task.
 *
 * Throws if the trigger is missing/invalid, the rendered prompt is empty,
 * or downstream services reject. MCP server attach failures are best-effort
 * (logged + skipped, doesn't abort).
 */
export async function fireAlwaysNewZoneTrigger(
  input: FireAlwaysNewZoneTriggerInput
): Promise<FireAlwaysNewZoneTriggerResult> {
  const { app, params, worktree, board, zone, user, userId } = input;

  const trigger = zone.trigger;
  if (!trigger?.template || !trigger.template.trim()) {
    throw new Error(`Zone "${zone.label ?? ''}" has no trigger template configured`);
  }
  if (trigger.behavior !== 'always_new') {
    throw new Error(
      `Zone "${zone.label ?? ''}" trigger behaviour is "${trigger.behavior}", expected "always_new"`
    );
  }

  const agenticTool: AgenticToolName =
    trigger.agent && VALID_AGENTS.includes(trigger.agent) ? trigger.agent : 'claude-code';

  const templateContext = buildZoneTriggerContext({
    worktree,
    board,
    zone: { label: zone.label, status: zone.status },
  });
  const renderedPrompt = renderTemplate(trigger.template, templateContext);
  if (!renderedPrompt.trim()) {
    throw new Error(
      `Zone "${zone.label ?? ''}" trigger rendered to an empty prompt; not creating session`
    );
  }

  const {
    permission_config: permissionConfig,
    model_config: modelConfig,
    mcp_server_ids: inheritedMcpIds,
  } = resolveSessionDefaults({ agenticTool, user, worktree });

  const { getGitState, getCurrentBranch } = await import('@agor/core/git');
  const currentSha = await getGitState(worktree.path);
  const currentRef = await getCurrentBranch(worktree.path);

  const newSession: Session = await app.service('sessions').create(
    {
      worktree_id: worktree.worktree_id,
      agentic_tool: agenticTool,
      status: 'idle',
      description: `Session from zone "${zone.label ?? ''}"`,
      created_by: userId,
      unix_username: user.unix_username,
      permission_config: permissionConfig,
      ...(modelConfig && { model_config: modelConfig }),
      git_state: {
        ref: currentRef,
        base_sha: currentSha,
        current_sha: currentSha,
      },
      genealogy: { children: [] },
      tasks: [],
    },
    params
  );

  // Best-effort MCP attach. The session is already created; one bad server
  // shouldn't strand the session. Mirrors the legacy MCP-tool behaviour.
  for (const mcpServerId of inheritedMcpIds) {
    try {
      await app
        .service('/sessions/:id/mcp-servers')
        .create({ mcpServerId }, { ...params, route: { id: newSession.session_id } });
    } catch (error) {
      console.warn(
        `[fireAlwaysNewZoneTrigger] Skipped MCP server ${mcpServerId} for session ${newSession.session_id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const task: Task = await app
    .service('/sessions/:id/prompt')
    .create(
      { prompt: renderedPrompt, messageSource: 'agor' },
      { ...params, route: { id: newSession.session_id } }
    );

  return { session: newSession, task };
}
