/**
 * Pure decision logic for the post-onboarding banners.
 *
 * The guiding invariant is FAIL SAFE: never surface a scary "not connected" /
 * "broken key" banner without POSITIVE proof of an unauthenticated tool. A
 * narrow client-side presence check (`hasAnyLlmKey`) cannot see credentials
 * that live only on the executor filesystem (a `claude /login` OAuth token in
 * `~/.claude/.credentials.json`, an instance/config-managed key), so the amber
 * banners are driven by the server-side check-auth probe instead.
 */

import type { AgenticToolName, User } from '@agor-live/client';

/**
 * Whether the client `user` object carries an LLM credential. This only sees
 * DB-stored keys — it CANNOT observe executor-filesystem credentials, so a
 * `false` result does not mean the user is unconnected.
 */
export function hasAnyLlmKey(user: User | null | undefined): boolean {
  if (!user) return false;
  const claude = user.agentic_tools?.['claude-code'];
  const codex = user.agentic_tools?.codex;
  const gemini = user.agentic_tools?.gemini;
  return !!(
    claude?.ANTHROPIC_API_KEY ||
    claude?.CLAUDE_CODE_OAUTH_TOKEN ||
    codex?.OPENAI_API_KEY ||
    gemini?.GEMINI_API_KEY ||
    user.env_vars?.ANTHROPIC_API_KEY ||
    user.env_vars?.OPENAI_API_KEY ||
    user.env_vars?.GEMINI_API_KEY
  );
}

/** Tools the check-auth probe can positively verify, in fallback preference order. */
const PROBE_AGENT_PREFERENCE: readonly AgenticToolName[] = ['claude-code', 'codex', 'gemini'];

/** The agent a stored DB key points at, if any. */
export function primaryAgentForUser(user: User | null | undefined): AgenticToolName | null {
  if (!user) return null;
  const claude = user.agentic_tools?.['claude-code'];
  const codex = user.agentic_tools?.codex;
  const gemini = user.agentic_tools?.gemini;
  if (
    claude?.ANTHROPIC_API_KEY ||
    claude?.CLAUDE_CODE_OAUTH_TOKEN ||
    user.env_vars?.ANTHROPIC_API_KEY
  )
    return 'claude-code';
  if (codex?.OPENAI_API_KEY || user.env_vars?.OPENAI_API_KEY) return 'codex';
  if (gemini?.GEMINI_API_KEY || user.env_vars?.GEMINI_API_KEY) return 'gemini';
  return null;
}

/** The agent the user selected during onboarding, read from their default config. */
function onboardingSelectedAgent(user: User | null | undefined): AgenticToolName | null {
  const config = user?.default_agentic_config;
  if (!config) return null;
  return PROBE_AGENT_PREFERENCE.find((tool) => config[tool]) ?? null;
}

/**
 * The single tool to probe for a given user: a stored key's tool, else the
 * onboarding-selected default, else Claude Code. Always resolves so the
 * probe can run even when no DB key is present (the false-positive case).
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
