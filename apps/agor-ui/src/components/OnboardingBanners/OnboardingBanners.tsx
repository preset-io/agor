/**
 * OnboardingBanners — persistent banners shown after onboarding if steps were skipped.
 *
 * Priority order (only one shows at a time):
 * 1. AI warning — the check-auth probe found no working LLM credential.
 * 2. Connection warning — a DB key exists but the probe rejected it.
 * 3. Integrations info — AI ok, no MCP servers and no gateway channels.
 *
 * Both warning banners require POSITIVE proof (probe Unauthenticated); the
 * decision logic lives in `bannerLogic.ts`.
 */

import type { AgenticToolName, AuthCheckResult, User } from '@agor-live/client';
import { Alert, Button, Space } from 'antd';
import { useEffect, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import {
  BannerDecision,
  decideBanner,
  hasConfiguredCredentialFor,
  ProbeState,
  preferredCredentialOwner,
  resolveGovernedProbeAgent,
  resolveProbeState,
} from './bannerLogic';

export interface OnboardingBannersProps {
  user: User | null | undefined;
  /** Total number of MCP servers configured for this user/instance. */
  mcpServerCount: number;
  /** Number of gateway channels (Slack/GitHub/etc.) the user has connected. */
  gatewayChannelCount: number;
  /** Whether both integration collections have finished their first hydration (gates the teal banner against a pre-hydration flash). */
  integrationsHydrated: boolean;
  /** Whether the user can reach the MCP settings tab (service enabled + sufficient role). Gates the integrations banner so its CTA is never a dead-end. */
  canManageMcp: boolean;
  /** Opens the user's personal AI credential settings at the given tool tab. */
  onOpenUserSettings: (tab: string) => void;
  /** Opens workspace settings at the given tab key (used for MCP). */
  onOpenWorkspaceSettings: (tab: string) => void;
  /** Server-side credential probe — resolves creds exactly as the executor, including executor-filesystem auth (`claude /login`). */
  onCheckAuth: (tool: AgenticToolName, apiKey?: string) => Promise<AuthCheckResult>;
  /** Bumped by the parent whenever credentials are saved — forces a re-probe even if key presence is unchanged (e.g. key rotation). */
  credentialVersion: number;
}

function AmberBanner({
  message,
  buttonLabel,
  onClick,
  docsHref,
}: {
  message: string;
  buttonLabel: string;
  onClick: () => void;
  docsHref?: string;
}) {
  return (
    <Alert
      banner
      showIcon
      type="warning"
      title={message}
      action={
        <Space size="small">
          {docsHref && (
            <Button
              type="link"
              size="small"
              href={docsHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              Documentation
            </Button>
          )}
          <Button type="primary" size="small" onClick={onClick}>
            {buttonLabel}
          </Button>
        </Space>
      }
    />
  );
}

export function OnboardingBanners({
  user,
  mcpServerCount,
  gatewayChannelCount,
  integrationsHydrated,
  canManageMcp,
  onOpenUserSettings,
  onOpenWorkspaceSettings,
  onCheckAuth,
  credentialVersion,
}: OnboardingBannersProps) {
  const [probeState, setProbeState] = useState<ProbeState>(ProbeState.Unknown);
  const [integrationsBannerDismissed, setIntegrationsBannerDismissed] = useState(false);
  const agenticToolSettings = useAgorStore((state) => state.agenticToolSettingsByName);

  // Pre-compute user-derived values so the effect captures primitives, not the full user object.
  const userId = user?.user_id;
  const onboardingCompleted = !!user?.onboarding_completed;
  const probeAgent = resolveGovernedProbeAgent(user, agenticToolSettings);
  const canonicalProbeAgent = probeAgent === 'claude-code-cli' ? 'claude-code' : probeAgent;
  const probeSettings = agenticToolSettings.get(canonicalProbeAgent as never);
  const hasLlm = hasConfiguredCredentialFor(user, probeAgent, probeSettings);
  const credentialOwner = preferredCredentialOwner(probeSettings);
  const canManageWorkspaceCredentials = user?.role === 'admin' || user?.role === 'superadmin';

  // Auth-method markers for the subscription/native paths (ChatGPT device
  // sign-in, imported Codex login, Claude subscription token). These land
  // server-side via their own services and flow back on the users `patched`
  // event WITHOUT a stored key or a credentialVersion bump — so hasLlm alone
  // can't see them. They are primitives ('api_key' | 'subscription' |
  // undefined) that change only on a genuine method flip, never on unrelated
  // user-record patches, keeping the ~5–10s probe from firing on name/emoji
  // edits. `agentic_auth_methods` only ever carries these two tools.
  const codexAuthMethod = user?.agentic_auth_methods?.codex;
  const claudeAuthMethod = user?.agentic_auth_methods?.['claude-code'];

  // One probe (plus a bounded fallback) per identity/credential change. Deps are
  // primitives/stable so the effect never re-fires on board navigation or
  // unrelated re-renders of the persistent App shell — each claude-code probe
  // spawns a ~5–10s subprocess. userId resets stale state on a user switch;
  // credentialVersion is a trigger-only dep re-probing after a legacy key save;
  // codexAuthMethod/claudeAuthMethod re-probe after a subscription/native login
  // lands server-side (device sign-in, auth.json import) — paths that bump
  // neither hasLlm nor credentialVersion — and cover a second browser tab too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: credentialVersion is an intentional trigger dep
  useEffect(() => {
    if (!onboardingCompleted) {
      setProbeState(ProbeState.Unknown);
      return;
    }
    setProbeState(ProbeState.Unknown);
    let cancelled = false;
    resolveProbeState(
      (tool) => onCheckAuth(tool).then((result) => result.status),
      probeAgent,
      hasLlm
    )
      .then((state) => {
        if (!cancelled) setProbeState(state);
      })
      .catch(() => {
        if (!cancelled) setProbeState(ProbeState.Unknown);
      });
    return () => {
      cancelled = true;
    };
  }, [
    userId,
    onboardingCompleted,
    probeAgent,
    hasLlm,
    onCheckAuth,
    credentialVersion,
    codexAuthMethod,
    claudeAuthMethod,
  ]);

  const decision = decideBanner({
    onboardingCompleted,
    hasLlm,
    probeState,
    canManageMcp,
    mcpServerCount,
    gatewayChannelCount,
    integrationsHydrated,
    integrationsBannerDismissed,
  });

  switch (decision) {
    case BannerDecision.None:
      return null;
    case BannerDecision.NoAi:
      return (
        <AmberBanner
          message="⚡ No AI connected - sessions will open but nothing will run."
          buttonLabel="Connect AI"
          onClick={() =>
            credentialOwner === 'tenant' && canManageWorkspaceCredentials
              ? onOpenWorkspaceSettings('agentic-tools')
              : onOpenUserSettings(probeAgent)
          }
          docsHref="https://agor.live/guide"
        />
      );
    case BannerDecision.KeyInvalid:
      return (
        <AmberBanner
          message="Your AI credentials aren't working. Sessions will fail until you reconnect."
          buttonLabel="Reconnect AI"
          onClick={() =>
            credentialOwner === 'tenant' && canManageWorkspaceCredentials
              ? onOpenWorkspaceSettings('agentic-tools')
              : onOpenUserSettings(probeAgent)
          }
        />
      );
    case BannerDecision.Integrations:
      return (
        <Alert
          banner
          showIcon
          type="info"
          title="Connect Slack, GitHub, or other tools via MCP to let your AI post updates and track issues."
          action={
            <Space size="small">
              <Button type="text" size="small" onClick={() => setIntegrationsBannerDismissed(true)}>
                Maybe later
              </Button>
              <Button type="primary" size="small" onClick={() => onOpenWorkspaceSettings('mcp')}>
                Connect tools
              </Button>
            </Space>
          }
        />
      );
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}
