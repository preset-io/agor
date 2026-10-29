import type {
  AgenticToolConfigField,
  AgenticToolName,
  AuthCheckStatus,
  Branch,
  Session,
} from '@agor/core/types';
import { isTeammate } from '@agor/core/types';

export function buildBranchCreatedAnalyticsProperties(branch: Branch): Record<string, unknown> {
  return {
    branch_id: branch.branch_id,
    repo_id: branch.repo_id,
    board_id: branch.board_id ?? null,
    ref_type: branch.ref_type ?? 'branch',
    new_branch: branch.new_branch,
    is_teammate: isTeammate(branch),
  };
}

export function buildSessionCreatedAnalyticsProperties(session: Session): Record<string, unknown> {
  return {
    session_id: session.session_id,
    branch_id: session.branch_id,
    agentic_tool: session.agentic_tool,
    agentic_tool_version: session.agentic_tool_version ?? null,
    model: session.model_config?.model ?? null,
    model_mode: session.model_config?.mode ?? null,
    provider: session.model_config?.provider ?? null,
    permission_mode: session.permission_config?.mode ?? null,
    has_parent_session: Boolean(session.genealogy?.parent_session_id),
    has_fork_source: Boolean(session.genealogy?.forked_from_session_id),
    fork_origin: session.fork_origin ?? null,
  };
}

/** How an LLM credential was supplied or proven; closed and secret-free. */
export type LlmCredentialMethod =
  | 'api_key'
  | 'subscription_token'
  | 'auth_token'
  | 'claude_oauth'
  | 'codex_device'
  | 'codex_import'
  | 'native_login';

/** Canonical credential fields; endpoints such as `*_BASE_URL` are configuration, not credentials. */
const LLM_CREDENTIAL_FIELD_METHODS = {
  ANTHROPIC_API_KEY: 'api_key',
  CLAUDE_CODE_OAUTH_TOKEN: 'subscription_token',
  ANTHROPIC_AUTH_TOKEN: 'auth_token',
  OPENAI_API_KEY: 'api_key',
  GEMINI_API_KEY: 'api_key',
  COPILOT_GITHUB_TOKEN: 'api_key',
  CURSOR_API_KEY: 'api_key',
} as const satisfies Partial<Record<AgenticToolConfigField, LlmCredentialMethod>>;

/** The credential method a saved field represents, or undefined for non-credential fields. */
export function llmCredentialMethodForField(
  tool: AgenticToolName,
  field: string
): LlmCredentialMethod | undefined {
  // Hosted OpenCode stores one API key per provider id.
  if (tool === 'opencode') return 'api_key';
  return Object.hasOwn(LLM_CREDENTIAL_FIELD_METHODS, field)
    ? LLM_CREDENTIAL_FIELD_METHODS[field as keyof typeof LLM_CREDENTIAL_FIELD_METHODS]
    : undefined;
}

export function buildLlmCredentialSavedAnalyticsProperties(
  agenticTool: AgenticToolName,
  method: LlmCredentialMethod
): Record<string, unknown> {
  return { agentic_tool: agenticTool, method };
}

export function buildLlmCredentialVerifiedAnalyticsProperties(
  agenticTool: AgenticToolName,
  method: LlmCredentialMethod,
  result: AuthCheckStatus
): Record<string, unknown> {
  return { agentic_tool: agenticTool, method, result };
}
