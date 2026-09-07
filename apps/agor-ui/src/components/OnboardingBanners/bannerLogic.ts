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
  ProviderResolutionPolicy,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
  User,
} from '@agor-live/client';
import { DEFAULT_PROVIDER_RESOLUTION_POLICY, PROVIDER_CREDENTIAL_FIELDS } from '@agor-live/client';
import {
  AVAILABLE_AGENTS,
  resolveAvailableUserAgenticTool,
} from '../AgentSelectionGrid/availableAgents';

function credentialFieldsFor(tool: AgenticToolName): readonly string[] {
  return Object.hasOwn(PROVIDER_CREDENTIAL_FIELDS, tool)
    ? PROVIDER_CREDENTIAL_FIELDS[tool as keyof typeof PROVIDER_CREDENTIAL_FIELDS]
    : [];
}

/** Whether `user` carries the active, provider-scoped credential for `tool`. */
function hasStoredCredentialFor(user: User, tool: AgenticToolName): boolean {
  const toolStatus = user.agentic_tools?.[tool] as Record<string, boolean | undefined> | undefined;
  const authMethod =
    tool === 'claude-code' || tool === 'codex' ? user.agentic_auth_methods?.[tool] : undefined;

  if (tool === 'codex' && authMethod === 'subscription') return true;

  return credentialFieldsFor(tool).some((field) => {
    if (tool === 'claude-code') {
      if (authMethod === 'subscription' && field !== 'CLAUDE_CODE_OAUTH_TOKEN') return false;
      if (authMethod === 'api_key' && field === 'CLAUDE_CODE_OAUTH_TOKEN') return false;
    }
    return !!toolStatus?.[field];
  });
}

/** Pick the same enabled tool that a new-session picker will initially select. */
export function resolveGovernedProbeAgent(
  user: User | null | undefined,
  settings: Map<TenantAgenticToolName, TenantAgenticToolSettings>
): AgenticToolName {
  return resolveAvailableUserAgenticTool(user, settings);
}

/**
 * Every tool the banner should probe: the governed default (what New Session
 * selects) plus each OTHER enabled tool the user/tenant already has a credential
 * for. A working credential on one of these is what lets the amber warning
 * soften instead of claiming all AI is down.
 */
export function probeableTools(
  user: User | null | undefined,
  settings: Map<TenantAgenticToolName, TenantAgenticToolSettings>,
  agents: readonly { id: string }[] = AVAILABLE_AGENTS
): AgenticToolName[] {
  const governed = resolveGovernedProbeAgent(user, settings);
  const isEnabled = (tool: string) =>
    settings.get(tool as TenantAgenticToolName)?.enabled !== false;
  const others = agents
    .map((agent) => agent.id as AgenticToolName)
    .filter(
      (tool) =>
        tool !== governed &&
        isEnabled(tool) &&
        hasConfiguredCredentialFor(user, tool, settings.get(tool as TenantAgenticToolName))
    );
  return [governed, ...others];
}

/**
 * Stable signature of one tool's credential state. A persistent dismissal keeps
 * a warning hidden until this fingerprint changes, so an unrelated tool's
 * credential save cannot resurface it — only a change to THIS tool's fields,
 * auth method, resolution policy, or tenant revision does.
 */
export function credentialFingerprint(
  user: User | null | undefined,
  tool: AgenticToolName,
  settings?: TenantAgenticToolSettings
): string {
  const fields = credentialFieldsFor(tool);
  const toolStatus = user?.agentic_tools?.[tool] as Record<string, boolean | undefined> | undefined;
  const userFields = fields.map((field) => !!toolStatus?.[field]);
  const authMethod =
    tool === 'claude-code' || tool === 'codex' ? user?.agentic_auth_methods?.[tool] : undefined;
  const tenantFields = fields.map(
    (field) => !!settings?.connection[field as keyof typeof settings.connection]?.configured
  );
  return JSON.stringify([
    tool,
    userFields,
    authMethod ?? null,
    settings?.revision ?? 0,
    tenantFields,
    settings?.resolution_policy ?? null,
  ]);
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
  const hasUserCredential = !!user && hasStoredCredentialFor(user, tool);
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

export type CredentialRemediationTarget = 'user' | 'tenant' | 'workspace-admin';

/**
 * Where the caller can actually repair the selected connection.
 *
 * Effective ownership and remediation authority differ for a member using a
 * workspace fallback under `user_preferred`: the current connection is tenant
 * owned, but adding a personal credential takes precedence and is actionable.
 */
export function credentialRemediationTarget(
  effectiveOwner: 'user' | 'tenant',
  resolutionPolicy: ProviderResolutionPolicy | undefined,
  canManageWorkspaceCredentials: boolean
): CredentialRemediationTarget {
  if (effectiveOwner === 'user') return 'user';
  if (canManageWorkspaceCredentials) return 'tenant';
  if (
    (resolutionPolicy ?? DEFAULT_PROVIDER_RESOLUTION_POLICY) === DEFAULT_PROVIDER_RESOLUTION_POLICY
  ) {
    return 'user';
  }
  return 'workspace-admin';
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
  /** Governed tool is broken but another credentialed tool passes its probe. */
  PartialAi: 'partial-ai',
  Integrations: 'integrations',
} as const;
export type BannerDecision = (typeof BannerDecision)[keyof typeof BannerDecision];

export interface BannerDecisionInput {
  onboardingCompleted: boolean;
  /** DB-key presence — used only to word the amber banner, never to hide it. */
  hasLlm: boolean;
  /** Probe verdict for the governed/default tool (what New Session selects). */
  probeState: ProbeState;
  /** Positive proof that a DIFFERENT credentialed tool passes its probe. */
  hasWorkingAlternative: boolean;
  canManageMcp: boolean;
  mcpServerCount: number;
  gatewayChannelCount: number;
  /** Whether both integration collections (mcp-servers + gateway-channels) have finished their first hydration. */
  integrationsHydrated: boolean;
  integrationsBannerDismissed: boolean;
  /** User+tool-scoped persistent dismissal of the amber warning. */
  credentialWarningDismissed: boolean;
  /** User+tool-scoped persistent dismissal of the softened partial-AI notice. */
  softWarningDismissed: boolean;
}

/**
 * Decide which single banner (if any) to show.
 *
 * An amber banner shows ONLY on positive proof of no working credential
 * (`probeState === 'unauthenticated'`); the DB-key presence merely picks the
 * wording ("No AI" vs "credentials broken"). While the probe is `unknown`,
 * neither amber banner shows — a brief false-negative beats a false-positive.
 *
 * When the governed tool is broken but another credentialed tool positively
 * passes, the amber warning softens to a dismissible informational notice: AI
 * is not down, only the one tool is. Both facts rest on positive probe proof.
 *
 * The teal integrations banner requires AI to be confirmed OK, both integration
 * collections hydrated (else the counts are not yet known — no premature flash),
 * and BOTH sources empty: MCP servers AND gateway channels (Slack/GitHub
 * connections live in the latter, a separate store map).
 */
export function decideBanner(input: BannerDecisionInput): BannerDecision {
  if (!input.onboardingCompleted) return BannerDecision.None;

  if (input.probeState === ProbeState.Unauthenticated) {
    if (input.hasWorkingAlternative) {
      return input.softWarningDismissed ? BannerDecision.None : BannerDecision.PartialAi;
    }
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
