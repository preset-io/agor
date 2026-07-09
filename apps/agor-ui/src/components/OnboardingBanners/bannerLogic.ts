/**
 * Pure decision logic for the post-onboarding banners.
 *
 * Guiding invariant: FAIL SAFE — never surface a "not connected" / "broken key"
 * banner without POSITIVE proof (`probeState === 'unauthenticated'`). The
 * client `user` object only carries DB-stored keys, so it cannot see
 * executor-filesystem credentials; the amber banners are therefore driven by
 * the server-side check-auth probe, not by a presence check.
 */

import type { AgenticToolName, User } from '@agor-live/client';

/**
 * Single source of truth for the agentic tools onboarding offers AND check-auth
 * can verify, in probe-preference order (recommended tools first). `hasAnyLlmKey`,
 * `primaryAgentForUser`, and `onboardingSelectedAgent` all derive from this so the
 * three lists cannot drift apart.
 *
 * `credentialFields` are the auth-indicating env-var names for each tool (matching
 * both `agentic_tools[tool]` and `env_vars`); base-URL fields are excluded. OpenCode
 * is server-based — no credential field — so it never contributes a stored key, but
 * a user who SELECTED it still resolves to probing `opencode` (always authenticated).
 */
const SUPPORTED_AGENTIC_TOOLS: readonly {
  tool: AgenticToolName;
  credentialFields: readonly string[];
}[] = [
  {
    tool: 'claude-code',
    credentialFields: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  },
  { tool: 'codex', credentialFields: ['OPENAI_API_KEY'] },
  { tool: 'gemini', credentialFields: ['GEMINI_API_KEY'] },
  { tool: 'copilot', credentialFields: ['COPILOT_GITHUB_TOKEN'] },
  { tool: 'cursor', credentialFields: ['CURSOR_API_KEY'] },
  { tool: 'opencode', credentialFields: [] },
];

/** Whether `user` carries a stored (DB or env-var) credential for `tool`. */
function hasStoredKeyFor(
  user: User,
  tool: AgenticToolName,
  credentialFields: readonly string[]
): boolean {
  const toolStatus = user.agentic_tools?.[tool] as Record<string, boolean | undefined> | undefined;
  const envVars = user.env_vars;
  return credentialFields.some((field) => !!toolStatus?.[field] || !!envVars?.[field]);
}

/**
 * Whether the client `user` object carries any LLM credential. This only sees
 * DB-stored keys — it CANNOT observe executor-filesystem credentials (e.g. a
 * `claude /login` token) or server-based tools, so a `false` result does not
 * mean the user is unconnected.
 */
export function hasAnyLlmKey(user: User | null | undefined): boolean {
  if (!user) return false;
  return SUPPORTED_AGENTIC_TOOLS.some(({ tool, credentialFields }) =>
    hasStoredKeyFor(user, tool, credentialFields)
  );
}

/** The first supported tool (preference order) with a stored key, if any. */
export function primaryAgentForUser(user: User | null | undefined): AgenticToolName | null {
  if (!user) return null;
  return (
    SUPPORTED_AGENTIC_TOOLS.find(({ tool, credentialFields }) =>
      hasStoredKeyFor(user, tool, credentialFields)
    )?.tool ?? null
  );
}

/** The first supported tool the user configured a default for during onboarding. */
function onboardingSelectedAgent(user: User | null | undefined): AgenticToolName | null {
  const config = user?.default_agentic_config;
  if (!config) return null;
  return SUPPORTED_AGENTIC_TOOLS.find(({ tool }) => config[tool])?.tool ?? null;
}

/**
 * The single tool to probe for a given user: a stored key's tool, else the
 * onboarding-selected default, else Claude Code. Always resolves so the probe
 * can run even when no DB key is present (the false-positive case).
 */
export function resolveProbeAgent(user: User | null | undefined): AgenticToolName {
  return primaryAgentForUser(user) ?? onboardingSelectedAgent(user) ?? 'claude-code';
}

/**
 * Result of the check-auth probe.
 * - `unknown`: initial, in-flight, or the probe threw. Treated as "no proof".
 * - `authenticated`: a working credential was found (DB or executor filesystem).
 * - `unauthenticated`: the probe ran and found no usable credential.
 */
export type ProbeState = 'unknown' | 'authenticated' | 'unauthenticated';

export type BannerDecision = 'none' | 'no-ai' | 'key-invalid' | 'integrations';

export interface BannerDecisionInput {
  onboardingCompleted: boolean;
  /** DB-key presence — used only to word the amber banner, never to hide it. */
  hasLlm: boolean;
  probeState: ProbeState;
  canManageMcp: boolean;
  mcpServerCount: number;
  gatewayChannelCount: number;
  integrationsBannerDismissed: boolean;
}

/**
 * Decide which single banner (if any) to show.
 *
 * An amber banner shows ONLY on positive proof of no working credential
 * (`probeState === 'unauthenticated'`); the DB-key presence merely picks the
 * wording ("No AI" vs "credentials broken"). While the probe is `unknown`,
 * neither amber banner shows — a brief false-negative beats a false-positive.
 *
 * The teal integrations banner requires AI to be confirmed OK and BOTH
 * integration sources empty: MCP servers AND gateway channels (Slack/GitHub
 * connections live in the latter, a separate store map).
 */
export function decideBanner(input: BannerDecisionInput): BannerDecision {
  if (!input.onboardingCompleted) return 'none';

  if (input.probeState === 'unauthenticated') {
    return input.hasLlm ? 'key-invalid' : 'no-ai';
  }

  const aiOk = input.probeState === 'authenticated' || input.hasLlm;
  const showIntegrations =
    aiOk &&
    input.canManageMcp &&
    input.mcpServerCount === 0 &&
    input.gatewayChannelCount === 0 &&
    !input.integrationsBannerDismissed;

  return showIntegrations ? 'integrations' : 'none';
}
