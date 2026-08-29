/**
 * Pure decision logic for the post-onboarding banners.
 *
 * Guiding invariant: FAIL SAFE — never surface a "not connected" / "broken key"
 * banner without POSITIVE proof (`probeState === 'unauthenticated'`) for the
 * selected, enabled tool. Credential presence only chooses the copy; the
 * server-side check-auth probe owns the verdict.
 */

import type {
  AgenticToolName,
  AuthCheckStatus,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
  User,
} from '@agor-live/client';
import { getUserPrimaryAgenticTool, PROVIDER_CREDENTIAL_FIELDS } from '@agor-live/client';

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
 * `credentialFields` are provider-scoped fields in `agentic_tools[tool]`;
 * base-URL fields and general managed env vars are excluded. OpenCode is
 * server-based — no credential field — so it never contributes a stored key,
 * but a user who selected it still resolves to probing `opencode` (always
 * authenticated).
 */
const SUPPORTED_AGENTIC_TOOLS: readonly {
  tool: AgenticToolName;
  credentialFields: readonly string[];
}[] = [
  { tool: 'claude-code', credentialFields: CLAUDE_CREDENTIAL_FIELDS },
  { tool: 'codex', credentialFields: ['OPENAI_API_KEY'] },
  { tool: 'gemini', credentialFields: ['GEMINI_API_KEY'] },
  { tool: 'copilot', credentialFields: ['COPILOT_GITHUB_TOKEN'] },
  { tool: 'cursor', credentialFields: ['CURSOR_API_KEY'] },
  { tool: 'opencode', credentialFields: [] },
];

/** Whether `user` carries the active, provider-scoped credential for `tool`. */
function hasStoredCredentialFor(
  user: User,
  tool: AgenticToolName,
  credentialFields: readonly string[]
): boolean {
  const toolStatus = user.agentic_tools?.[tool] as Record<string, boolean | undefined> | undefined;
  const authMethod =
    tool === 'claude-code' || tool === 'codex' ? user.agentic_auth_methods?.[tool] : undefined;

  if (tool === 'codex' && authMethod === 'subscription') return true;

  return credentialFields.some((field) => {
    if (tool === 'claude-code') {
      if (authMethod === 'subscription' && field !== 'CLAUDE_CODE_OAUTH_TOKEN') return false;
      if (authMethod === 'api_key' && field === 'CLAUDE_CODE_OAUTH_TOKEN') return false;
    }
    return !!toolStatus?.[field];
  });
}

/**
 * Whether the client `user` object carries any active, provider-scoped LLM
 * credential. General `env_vars` intentionally do not count: provider
 * credentials are resolved only from `agentic_tools` under workspace policy,
 * and the executor strips ambient provider variables before installing that
 * resolved connection.
 */
export function hasAnyLlmKey(user: User | null | undefined): boolean {
  if (!user) return false;
  return SUPPORTED_AGENTIC_TOOLS.some(({ tool, credentialFields }) =>
    hasStoredCredentialFor(user, tool, credentialFields)
  );
}

/** The first supported tool (preference order) with an active credential, if any. */
export function primaryAgentForUser(user: User | null | undefined): AgenticToolName | null {
  if (!user) return null;
  return (
    SUPPORTED_AGENTIC_TOOLS.find(({ tool, credentialFields }) =>
      hasStoredCredentialFor(user, tool, credentialFields)
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
 * The single tool to probe for a given user: their explicit primary tool, a
 * stored key's tool, the onboarding-selected default, then Claude Code.
 * Always resolves so the probe can run even when no DB key is present (the
 * false-positive case).
 */
export function resolveProbeAgent(user: User | null | undefined): AgenticToolName {
  return (
    getUserPrimaryAgenticTool(user) ??
    primaryAgentForUser(user) ??
    onboardingSelectedAgent(user) ??
    'claude-code'
  );
}

/** Pick one enabled, policy-governed provider for the persistent auth banner. */
export function resolveGovernedProbeAgent(
  user: User | null | undefined,
  settings: Map<TenantAgenticToolName, TenantAgenticToolSettings>
): AgenticToolName {
  const preferred = resolveProbeAgent(user);
  if (settings.get(preferred as TenantAgenticToolName)?.enabled !== false) return preferred;
  const fallback = SUPPORTED_AGENTIC_TOOLS.find(
    ({ tool }) => settings.get(tool as TenantAgenticToolName)?.enabled !== false
  );
  return fallback?.tool ?? 'claude-code';
}

export function hasConfiguredCredentialFor(
  user: User | null | undefined,
  tool: AgenticToolName,
  settings?: TenantAgenticToolSettings
): boolean {
  const { hasUserCredential, hasTenantCredential } = credentialPresenceFor(user, tool, settings);
  if (settings?.resolution_policy === 'user_required') return hasUserCredential;
  if (settings?.resolution_policy === 'tenant_required') return hasTenantCredential;
  return hasUserCredential || hasTenantCredential;
}

function credentialPresenceFor(
  user: User | null | undefined,
  tool: AgenticToolName,
  settings?: TenantAgenticToolSettings
): { hasUserCredential: boolean; hasTenantCredential: boolean } {
  const spec = SUPPORTED_AGENTIC_TOOLS.find((candidate) => candidate.tool === tool);
  const hasUserCredential =
    !!user && !!spec && hasStoredCredentialFor(user, tool, spec.credentialFields);
  const fields: readonly string[] = Object.hasOwn(PROVIDER_CREDENTIAL_FIELDS, tool)
    ? PROVIDER_CREDENTIAL_FIELDS[tool as keyof typeof PROVIDER_CREDENTIAL_FIELDS]
    : [];
  const hasTenantCredential = fields.some(
    (field) => settings?.connection[field as keyof typeof settings.connection]?.configured
  );
  return { hasUserCredential, hasTenantCredential };
}

/** The owner whose complete connection the resolver will select under policy. */
export function resolvedCredentialOwner(
  user: User | null | undefined,
  tool: AgenticToolName,
  settings?: TenantAgenticToolSettings
): 'user' | 'tenant' {
  const { hasUserCredential, hasTenantCredential } = credentialPresenceFor(user, tool, settings);
  switch (settings?.resolution_policy) {
    case 'tenant_required':
      return 'tenant';
    case 'user_required':
      return 'user';
    case 'tenant_preferred':
      return hasTenantCredential ? 'tenant' : 'user';
    default:
      return hasUserCredential || !hasTenantCredential ? 'user' : 'tenant';
  }
}

/**
 * Resolve the probe state for exactly one selected, enabled tool.
 *
 * A working credential for a different tool does not make sessions for this
 * tool runnable, and a failure for a different tool must not produce a global
 * warning. `unknown` remains fail-safe.
 */
export async function resolveProbeState(
  checkStatus: (tool: AgenticToolName) => Promise<AuthCheckStatus>,
  probeAgent: AgenticToolName
): Promise<ProbeState> {
  const status = await checkStatus(probeAgent);
  if (status === 'authenticated') return ProbeState.Authenticated;
  if (status === 'unauthenticated') return ProbeState.Unauthenticated;
  return ProbeState.Unknown;
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
  /** A user-scoped 24-hour snooze of the selected tool's warning. */
  credentialWarningDismissed: boolean;
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
    if (input.credentialWarningDismissed) return BannerDecision.None;
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
