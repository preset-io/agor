/**
 * Spawn-subsession meta-prompt.
 *
 * Wraps the user's intent + agent config in instructions that tell the
 * *parent* session's LLM to call the `agor_sessions_spawn` MCP tool with an
 * enriched prompt. The output of this template is sent as a chat message to
 * the parent session — it's not a side-effecting daemon action; it's a
 * prompt envelope.
 *
 * Lives in core (not the UI) so the daemon can render it server-side via
 * `/sessions/:id/spawn-prompt`, sparing the browser bundle Handlebars and a
 * round-trip.
 */

import { renderTemplate } from './handlebars-helpers';

export interface SpawnSubsessionContext {
  userPrompt: string;
  hasConfig?: boolean;
  agenticTool?: string;
  permissionMode?: string;
  modelConfig?: {
    mode?: string;
    model?: string;
    effort?: string;
  };
  codexSandboxMode?: string;
  codexApprovalPolicy?: string;
  codexNetworkAccess?: boolean;
  mcpServerIds?: string[];
  hasCallbackConfig?: boolean;
  callbackConfig?: {
    enableCallback?: boolean;
    includeLastMessage?: boolean;
    includeOriginalPrompt?: boolean;
  };
  extraInstructions?: string;
}

const SPAWN_SUBSESSION_TEMPLATE = `INSTRUCTION: The user is requesting a subsession to handle a delegated task. You MUST use the Agor
MCP tool 'agor_sessions_spawn' to create a child session that will handle this request. USER
REQUEST: """
{{userPrompt}}
"""

{{#if hasConfig}}
  USER CONFIGURATION:
  {{#if agenticTool}}
    - Agentic Tool:
    {{agenticTool}}
  {{/if}}
  {{#if permissionMode}}
    - Permission Mode:
    {{permissionMode}}
  {{/if}}
  {{#if modelConfig}}
    - Model:
    {{modelConfig.mode}}
    -
    {{modelConfig.model}}{{#if modelConfig.effort}}
      (effort:
      {{modelConfig.effort}}){{/if}}
  {{/if}}
  {{#if codexSandboxMode}}
    - Codex Sandbox Mode:
    {{codexSandboxMode}}
  {{/if}}
  {{#if codexApprovalPolicy}}
    - Codex Approval Policy:
    {{codexApprovalPolicy}}
  {{/if}}
  {{#if codexNetworkAccess}}
    - Codex Network Access: enabled
  {{/if}}
  {{#if mcpServerIds}}
    - MCP Servers:
    {{mcpServerIds}}
  {{/if}}
  {{#if hasCallbackConfig}}
    - Callback Configuration:
    {{#if callbackConfig.enableCallback}}ENABLED - Include last message:
      {{callbackConfig.includeLastMessage}}
      - Include original prompt:
      {{callbackConfig.includeOriginalPrompt}}{{else}}NO CALLBACK{{/if}}
  {{/if}}
  {{#if extraInstructions}}
    - Extra Instructions: """
    {{extraInstructions}}
    """
  {{/if}}
{{/if}}

YOUR TASK: You must call the agor_sessions_spawn MCP tool with a comprehensive prompt. Do NOT
respond directly to the user. Steps: 1. Analyze the user's request and identify what context from
THIS session would be helpful 2. Prepare a detailed prompt for the child session that includes: -
The user's core request with full context - Relevant context from this session (code locations,
decisions made, patterns to follow) - Clear success criteria and expected outputs 3. Call
agor_sessions_spawn with your enriched prompt and the configuration specified above EXAMPLE: User:
"add tests" Correct response: Call agor_sessions_spawn with: - prompt: "Write Jest unit tests for
the authentication module at src/auth/. Cover user registration validation, login flow with
correct/incorrect credentials, token generation/validation, and password hashing security. Follow
the existing test patterns in tests/auth/. Aim for 80%+ coverage. The auth module uses bcrypt for
hashing and JWT for tokens."
{{#if agenticTool}}
  - agenticTool: "{{agenticTool}}"
{{/if}}
{{#if permissionMode}}
  - permissionMode: "{{permissionMode}}"
{{/if}}
{{#if modelConfig}}
  - modelConfig: { mode: "{{modelConfig.mode}}", model: "{{modelConfig.model}}"{{#if
    modelConfig.effort
  }}, effort: "{{modelConfig.effort}}"{{/if}}
  }
{{/if}}
{{#if codexSandboxMode}}
  - codexSandboxMode: "{{codexSandboxMode}}"
{{/if}}
{{#if codexApprovalPolicy}}
  - codexApprovalPolicy: "{{codexApprovalPolicy}}"
{{/if}}
{{#if codexNetworkAccess}}
  - codexNetworkAccess:
  {{codexNetworkAccess}}
{{/if}}
{{#if mcpServerIds}}
  - mcpServerIds: [{{#each mcpServerIds}}"{{this}}"{{#unless @last}}, {{/unless}}{{/each}}]
{{/if}}
{{#if (isDefined callbackConfig.enableCallback)}}
  - enableCallback:
  {{callbackConfig.enableCallback}}
{{/if}}
{{#if (isDefined callbackConfig.includeLastMessage)}}
  - includeLastMessage:
  {{callbackConfig.includeLastMessage}}
{{/if}}
{{#if (isDefined callbackConfig.includeOriginalPrompt)}}
  - includeOriginalPrompt:
  {{callbackConfig.includeOriginalPrompt}}
{{/if}}
{{#if extraInstructions}}
  - extraInstructions: """{{extraInstructions}}"""
{{/if}}

CRITICAL: - Do NOT explain or respond directly to the user - ALWAYS use the MCP tool - this is
mandatory - The child session starts fresh - include ALL relevant context in your prompt - Use the
exact configuration parameters specified above - After spawning, briefly acknowledge what the child
session will do YOUR EXACT TOOL CALL MUST BE: agor_sessions_spawn({ "prompt": "{{your_carefully_prepared_enriched_prompt_with_full_context}}",{{#if
  agenticTool
}}
  "agenticTool": "{{agenticTool}}",{{/if}}{{#if permissionMode}}
  "permissionMode": "{{permissionMode}}",{{/if}}{{#if modelConfig}}
  "modelConfig": { "mode": "{{modelConfig.mode}}", "model": "{{modelConfig.model}}"{{#if
    modelConfig.effort
  }}, "effort": "{{modelConfig.effort}}"{{/if}}
  },{{/if}}{{#if codexSandboxMode}}
  "codexSandboxMode": "{{codexSandboxMode}}",{{/if}}{{#if codexApprovalPolicy}}
  "codexApprovalPolicy": "{{codexApprovalPolicy}}",{{/if}}{{#if codexNetworkAccess}}
  "codexNetworkAccess":
  {{codexNetworkAccess}},{{/if}}{{#if mcpServerIds}}
  "mcpServerIds": [{{#each mcpServerIds}}"{{this}}"{{#unless @last}},
    {{/unless}}{{/each}}],{{/if}}{{#if (isDefined callbackConfig.enableCallback)}}
  "enableCallback":
  {{callbackConfig.enableCallback}},{{/if}}{{#if (isDefined callbackConfig.includeLastMessage)}}
  "includeLastMessage":
  {{callbackConfig.includeLastMessage}},{{/if}}{{#if
  (isDefined callbackConfig.includeOriginalPrompt)
}}
  "includeOriginalPrompt":
  {{callbackConfig.includeOriginalPrompt}},{{/if}}{{#if extraInstructions}}
  "extraInstructions": """{{extraInstructions}}"""{{/if}}
}) Proceed now by calling agor_sessions_spawn with the exact parameters shown above.`;

/**
 * Render the spawn-subsession meta-prompt for a parent session's LLM.
 * Internally derives the `hasConfig` / `hasCallbackConfig` flags from the
 * supplied context so callers don't have to.
 */
export function renderSpawnSubsessionPrompt(context: SpawnSubsessionContext): string {
  const hasConfig =
    context.hasConfig ??
    (context.agenticTool !== undefined ||
      context.permissionMode !== undefined ||
      context.modelConfig !== undefined ||
      context.codexSandboxMode !== undefined ||
      context.codexApprovalPolicy !== undefined ||
      context.codexNetworkAccess !== undefined ||
      (context.mcpServerIds?.length ?? 0) > 0 ||
      context.callbackConfig?.enableCallback !== undefined ||
      context.callbackConfig?.includeLastMessage !== undefined ||
      context.callbackConfig?.includeOriginalPrompt !== undefined ||
      context.extraInstructions !== undefined);

  const hasCallbackConfig =
    context.hasCallbackConfig ??
    (context.callbackConfig?.enableCallback !== undefined ||
      context.callbackConfig?.includeLastMessage !== undefined ||
      context.callbackConfig?.includeOriginalPrompt !== undefined);

  return renderTemplate(SPAWN_SUBSESSION_TEMPLATE, {
    ...context,
    hasConfig,
    hasCallbackConfig,
  } as unknown as Record<string, unknown>);
}
