/**
 * OnboardingBanners — persistent banners shown after onboarding if steps were skipped.
 *
 * Priority order (only one shows at a time):
 * 1. AI banner (amber)  — the check-auth probe found no working LLM credential.
 * 2. Connection invalid banner (amber) — a DB key exists but the probe rejected it.
 * 3. Integrations banner (teal) — AI ok, no MCP servers and no gateway channels.
 *
 * Both amber banners require POSITIVE proof (probe Unauthenticated); the
 * decision logic lives in `bannerLogic.ts`.
 */

import type { AgenticToolName, AuthCheckResult, User } from '@agor-live/client';
import { Button } from 'antd';
import { useEffect, useState } from 'react';
import {
  BannerDecision,
  decideBanner,
  hasAnyLlmKey,
  ProbeState,
  resolveProbeAgent,
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

const AMBER_BANNER_STYLE = {
  background: '#78350f',
  borderBottom: '1px solid #92400e',
  height: 48,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingLeft: 20,
  paddingRight: 20,
  flexShrink: 0,
  zIndex: 10,
} as const;

const AMBER_BUTTON_STYLE = {
  background: '#d97706',
  borderColor: '#d97706',
  color: '#fff',
  fontWeight: 600,
  fontSize: 12,
} as const;

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
    <div style={AMBER_BANNER_STYLE}>
      <span style={{ color: '#fde68a', fontSize: 13, fontWeight: 500 }}>{message}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {docsHref && (
          <Button
            type="text"
            size="small"
            href={docsHref}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#fde68a', borderColor: 'rgba(253,230,138,0.4)', fontSize: 12 }}
          >
            Documentation
          </Button>
        )}
        <Button size="small" onClick={onClick} style={AMBER_BUTTON_STYLE}>
          {buttonLabel}
        </Button>
      </div>
    </div>
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

  // Pre-compute user-derived values so the effect captures primitives, not the full user object.
  const userId = user?.user_id;
  const onboardingCompleted = !!user?.onboarding_completed;
  const hasLlm = hasAnyLlmKey(user);
  const probeAgent = resolveProbeAgent(user);

  // One probe (plus a bounded fallback) per identity/credential change. Deps are
  // primitives/stable so the effect never re-fires on board navigation or
  // unrelated re-renders of the persistent App shell — each claude-code probe
  // spawns a ~5–10s subprocess. userId resets stale state on a user switch;
  // credentialVersion is a trigger-only dep re-probing after a credential save.
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
  }, [userId, onboardingCompleted, probeAgent, hasLlm, onCheckAuth, credentialVersion]);

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
          onClick={() => onOpenUserSettings(probeAgent)}
          docsHref="https://agor.live/guide"
        />
      );
    case BannerDecision.KeyInvalid:
      return (
        <AmberBanner
          message="Your AI credentials aren't working. Sessions will fail until you reconnect."
          buttonLabel="Reconnect AI"
          onClick={() => onOpenUserSettings(probeAgent)}
        />
      );
    case BannerDecision.Integrations:
      return (
        <div
          style={{
            background: 'rgba(46,154,146,0.1)',
            borderBottom: '1px solid rgba(46,154,146,0.35)',
            height: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingLeft: 20,
            paddingRight: 20,
            flexShrink: 0,
            zIndex: 10,
          }}
        >
          <span style={{ color: '#7dd3ce', fontSize: 13, fontWeight: 500 }}>
            Connect Slack, GitHub, or other tools via MCP to let your AI post updates and track
            issues.
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button
              type="text"
              size="small"
              onClick={() => setIntegrationsBannerDismissed(true)}
              style={{ color: '#94a3b8', fontSize: 12 }}
            >
              Maybe later
            </Button>
            <Button
              size="small"
              onClick={() => onOpenWorkspaceSettings('mcp')}
              style={{
                background: '#2e9a92',
                borderColor: '#2e9a92',
                color: '#fff',
                fontWeight: 600,
                fontSize: 12,
              }}
            >
              Connect tools
            </Button>
          </div>
        </div>
      );
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}
