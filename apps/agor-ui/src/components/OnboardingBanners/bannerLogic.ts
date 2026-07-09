/**
 * Pure decision logic for the post-onboarding banners.
 *
 * Guiding invariant: FAIL SAFE — never surface a "not connected" / "broken key"
 * banner without POSITIVE proof (`probeState === 'unauthenticated'`). The
 * client `user` object only carries DB-stored keys, so it cannot see
 * executor-filesystem credentials; the amber banners are therefore driven by
 * the server-side check-auth probe, not by a presence check.
 */

import type { AgenticToolName, AuthCheckStatus, User } from '@agor-live/client';

const CLAUDE_CREDENTIAL_FIELDS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
];

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
 * `probeTarget` overrides which tool check-auth actually verifies: claude-code-cli
 * shares Claude's credentials and native path, so it is probed as claude-code.
 */
const SUPPORTED_AGENTIC_TOOLS: readonly {
  tool: AgenticToolName;
  credentialFields: readonly string[];
  probeTarget?: AgenticToolName;
}[] = [
  { tool: 'claude-code', credentialFields: CLAUDE_CREDENTIAL_FIELDS },
  {
    tool: 'claude-code-cli',
    credentialFields: CLAUDE_CREDENTIAL_FIELDS,
    probeTarget: 'claude-code',
  },
  { tool: 'codex', credentialFields: ['OPENAI_API_KEY'] },
  { tool: 'gemini', credentialFields: ['GEMINI_API_KEY'] },
  { tool: 'copilot', credentialFields: ['COPILOT_GITHUB_TOKEN'] },
  { tool: 'cursor', credentialFields: ['CURSOR_API_KEY'] },
  { tool: 'opencode', credentialFields: [] },
];

/** Reliably server-probeable native tools, tried as a fallback before concluding "No AI". */
const NATIVE_FALLBACK_TOOLS: readonly AgenticToolName[] = ['claude-code', 'codex'];

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

/** The tool check-auth should verify for `tool` (maps claude-code-cli → claude-code). */
function probeTargetFor(tool: AgenticToolName): AgenticToolName {
  return SUPPORTED_AGENTIC_TOOLS.find((spec) => spec.tool === tool)?.probeTarget ?? tool;
}

/**
 * The single tool to probe for a given user: a stored key's tool, else the
 * onboarding-selected default, else Claude Code, mapped to its probe target.
 * Always resolves so the probe can run even when no DB key is present (the
 * false-positive case).
 */
export function resolveProbeAgent(user: User | null | undefined): AgenticToolName {
  return probeTargetFor(
    primaryAgentForUser(user) ?? onboardingSelectedAgent(user) ?? 'claude-code'
  );
}

/**
 * Resolve the probe state for a user, with a bounded multi-tool fallback.
 *
 * The primary tool's verdict wins outright unless it is a positive
 * `unauthenticated` AND the user has no stored key: only then do we also probe
 * the reliably-native tools (a working `claude /login` under a stale non-claude
 * default would otherwise false-positive). We show Unauthenticated only if EVERY
 * probe positively says so; any `authenticated` clears it, any `unknown` fails
 * safe to Unknown. Early-exits on the first `authenticated`; at most a couple of
 * extra sequential probes on the already-rare no-key path.
 */
export async function resolveProbeState(
  checkStatus: (tool: AgenticToolName) => Promise<AuthCheckStatus>,
  probeAgent: AgenticToolName,
  hasLlm: boolean
): Promise<ProbeState> {
  const primary = await checkStatus(probeAgent);
  if (primary === 'authenticated') return ProbeState.Authenticated;
  if (primary === 'unknown') return ProbeState.Unknown;
  if (hasLlm) return ProbeState.Unauthenticated;

  for (const tool of NATIVE_FALLBACK_TOOLS) {
    if (tool === probeAgent) continue;
    const status = await checkStatus(tool);
    if (status === 'authenticated') return ProbeState.Authenticated;
    if (status === 'unknown') return ProbeState.Unknown;
  }
  return ProbeState.Unauthenticated;
}

/**
 * Result of the check-auth probe.
 * - `Unknown`: initial, in-flight, or the probe threw. Treated as "no proof".
 * - `Authenticated`: a working credential was found (DB or executor filesystem).
 * - `Unauthenticated`: the probe ran and found no usable credential.
 */
// Object-const enums (not TS `enum`): the UI package compiles with
// `erasableSyntaxOnly`, which forbids the runtime-emitting `enum` form.
export const ProbeState = {
  Unknown: 'unknown',
  Authenticated: 'authenticated',
  Unauthenticated: 'unauthenticated',
} as const;
export type ProbeState = (typeof ProbeState)[keyof typeof ProbeState];

export const BannerDecision = {
  None: 'none',
  NoAi: 'no-ai',
  KeyInvalid: 'key-invalid',
  Integrations: 'integrations',
} as const;
export type BannerDecision = (typeof BannerDecision)[keyof typeof BannerDecision];

export interface BannerDecisionInput {
  onboardingCompleted: boolean;
  /** DB-key presence — used only to word the amber banner, never to hide it. */
  hasLlm: boolean;
  probeState: ProbeState;
  canManageMcp: boolean;
  mcpServerCount: number;
  gatewayChannelCount: number;
  /** Whether both integration collections (mcp-servers + gateway-channels) have finished their first hydration. */
  integrationsHydrated: boolean;
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
 * The teal integrations banner requires AI to be confirmed OK, both integration
 * collections hydrated (else the counts are not yet known — no premature flash),
 * and BOTH sources empty: MCP servers AND gateway channels (Slack/GitHub
 * connections live in the latter, a separate store map).
 */
export function decideBanner(input: BannerDecisionInput): BannerDecision {
  if (!input.onboardingCompleted) return BannerDecision.None;

  if (input.probeState === ProbeState.Unauthenticated) {
    return input.hasLlm ? BannerDecision.KeyInvalid : BannerDecision.NoAi;
  }

  const aiOk = input.probeState === ProbeState.Authenticated || input.hasLlm;
  const showIntegrations =
    aiOk &&
    input.integrationsHydrated &&
    input.canManageMcp &&
    input.mcpServerCount === 0 &&
    input.gatewayChannelCount === 0 &&
    !input.integrationsBannerDismissed;

  return showIntegrations ? BannerDecision.Integrations : BannerDecision.None;
}
