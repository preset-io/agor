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

import { AGENTIC_TOOL_DISPLAY_NAMES } from '@agor/agentic-tools';
import type { AgenticToolName, AuthCheckResult, User } from '@agor-live/client';
import { Alert, Button, Space } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import {
  BannerDecision,
  decideBanner,
  hasConfiguredCredentialFor,
  ProbeState,
  resolvedCredentialOwner,
  resolveGovernedProbeAgent,
  resolveProbeState,
} from './bannerLogic';
import {
  clearCredentialWarningSnooze,
  readCredentialWarningSnooze,
  writeCredentialWarningSnooze,
} from './credentialWarningDismissal';

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
  /** False during disconnect/reauth. Probes resume from Unknown after reconnect. */
  connectionReady: boolean;
}

function AmberBanner({
  message,
  buttonLabel,
  onClick,
  docsHref,
  onDismiss,
  dismissLabel,
}: {
  message: string;
  buttonLabel: string;
  onClick: () => void;
  docsHref?: string;
  onDismiss: () => void;
  dismissLabel: string;
}) {
  return (
    <Alert
      banner
      showIcon
      type="warning"
      title={message}
      closable={{ closeIcon: true, onClose: onDismiss, 'aria-label': dismissLabel }}
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
  connectionReady,
}: OnboardingBannersProps) {
  const [probeResult, setProbeResult] = useState<{ owner: string; state: ProbeState }>({
    owner: '',
    state: ProbeState.Unknown,
  });
  const [integrationsBannerDismissed, setIntegrationsBannerDismissed] = useState(false);
  const [credentialWarningSnoozedUntil, setCredentialWarningSnoozedUntil] = useState<number | null>(
    null
  );
  const [probeRefreshVersion, setProbeRefreshVersion] = useState(0);
  const priorCredentialVersion = useRef<{ owner: string | null; version: number } | null>(null);
  const agenticToolSettings = useAgorStore((state) => state.agenticToolSettingsByName);
  const agenticToolSettingsHydrated = useAgorStore((state) => state.agenticToolSettingsHydrated);

  // Pre-compute user-derived values so the effect captures primitives, not the full user object.
  const userId = user?.user_id;
  const onboardingCompleted = !!user?.onboarding_completed;
  const probeAgent = resolveGovernedProbeAgent(user, agenticToolSettings);
  const probeSettings = agenticToolSettings.get(probeAgent as never);
  const probeEnabled = probeSettings?.enabled !== false;
  const hasLlm = hasConfiguredCredentialFor(user, probeAgent, probeSettings);
  const credentialOwner = resolvedCredentialOwner(user, probeAgent, probeSettings);
  const canManageWorkspaceCredentials = user?.role === 'admin' || user?.role === 'superadmin';
  const displayName = AGENTIC_TOOL_DISPLAY_NAMES[probeAgent] ?? probeAgent;
  const dismissalOwner = userId ? `${userId}:${probeAgent}` : null;
  const userCredentialRevision = user?.updated_at ? String(user.updated_at) : '';

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
  const probeOwner = JSON.stringify([
    userId,
    userCredentialRevision,
    onboardingCompleted,
    connectionReady,
    agenticToolSettingsHydrated,
    probeAgent,
    probeEnabled,
    probeSettings,
    credentialVersion,
    probeRefreshVersion,
    codexAuthMethod,
    claudeAuthMethod,
  ]);
  // Never render an old user's/tool's verdict for one frame while the effect
  // below is scheduling its replacement.
  const probeState = probeResult.owner === probeOwner ? probeResult.state : ProbeState.Unknown;

  // One selected-tool probe per identity/credential change. Deps are
  // primitives/stable so the effect never re-fires on board navigation or
  // unrelated App-shell renders. `updated_at` deliberately covers a same-field
  // credential rotation delivered by realtime (presence stays `true`, so a
  // boolean-only dependency would be stale). userId resets state on a switch;
  // credentialVersion covers the local save path before realtime lands;
  // codexAuthMethod/claudeAuthMethod re-probe after a subscription/native login
  // lands server-side (device sign-in, auth.json import) — paths that bump
  // neither hasLlm nor credentialVersion — and cover a second browser tab too.
  useEffect(() => {
    if (!onboardingCompleted || !connectionReady || !agenticToolSettingsHydrated || !probeEnabled) {
      setProbeResult({ owner: probeOwner, state: ProbeState.Unknown });
      return;
    }
    setProbeResult({ owner: probeOwner, state: ProbeState.Unknown });
    let cancelled = false;
    resolveProbeState((tool) => onCheckAuth(tool).then((result) => result.status), probeAgent)
      .then((state) => {
        if (!cancelled) setProbeResult({ owner: probeOwner, state });
      })
      .catch(() => {
        if (!cancelled) setProbeResult({ owner: probeOwner, state: ProbeState.Unknown });
      });
    return () => {
      cancelled = true;
    };
  }, [
    onboardingCompleted,
    connectionReady,
    agenticToolSettingsHydrated,
    probeAgent,
    probeEnabled,
    onCheckAuth,
    probeOwner,
  ]);

  // A warning can be snoozed for 24 hours, scoped to one user + one selected
  // tool. A local credential save clears the snooze so failed reconnects are
  // immediately actionable; successful reconnects disappear through the probe.
  useEffect(() => {
    const previous = priorCredentialVersion.current;
    const credentialChanged =
      !!dismissalOwner &&
      previous?.owner === dismissalOwner &&
      previous.version !== credentialVersion;
    priorCredentialVersion.current = { owner: dismissalOwner, version: credentialVersion };

    if (!userId || !dismissalOwner || typeof window === 'undefined') {
      setCredentialWarningSnoozedUntil(null);
      return;
    }

    if (credentialChanged) {
      clearCredentialWarningSnooze(window.localStorage, userId, probeAgent);
    }
    const snoozedUntil = credentialChanged
      ? null
      : readCredentialWarningSnooze(window.localStorage, userId, probeAgent);
    setCredentialWarningSnoozedUntil(snoozedUntil);
  }, [credentialVersion, dismissalOwner, probeAgent, userId]);

  useEffect(() => {
    if (!credentialWarningSnoozedUntil || typeof window === 'undefined') return;

    const timer = window.setTimeout(
      () => {
        setCredentialWarningSnoozedUntil(null);
        // A day-old rejection is no longer authoritative enough to re-display.
        // Re-probe from Unknown before reminding the user.
        setProbeRefreshVersion((version) => version + 1);
      },
      Math.min(credentialWarningSnoozedUntil - Date.now(), 2_147_483_647)
    );
    return () => window.clearTimeout(timer);
  }, [credentialWarningSnoozedUntil]);

  const dismissCredentialWarning = () => {
    if (!userId || typeof window === 'undefined') return;
    setCredentialWarningSnoozedUntil(
      writeCredentialWarningSnooze(window.localStorage, userId, probeAgent)
    );
  };

  const decision = decideBanner({
    onboardingCompleted,
    hasLlm,
    probeState,
    canManageMcp,
    mcpServerCount,
    gatewayChannelCount,
    integrationsHydrated,
    integrationsBannerDismissed,
    credentialWarningDismissed:
      credentialWarningSnoozedUntil !== null && credentialWarningSnoozedUntil > Date.now(),
  });

  switch (decision) {
    case BannerDecision.None:
      return null;
    case BannerDecision.NoAi:
      return (
        <AmberBanner
          message={`${displayName} isn't connected. New ${displayName} sessions won't run until you configure it.`}
          buttonLabel={`Open ${displayName} settings`}
          onClick={() =>
            credentialOwner === 'tenant' && canManageWorkspaceCredentials
              ? onOpenWorkspaceSettings('agentic-tools')
              : onOpenUserSettings(probeAgent)
          }
          docsHref="https://agor.live/guide"
          onDismiss={dismissCredentialWarning}
          dismissLabel={`Snooze ${displayName} warning for 24 hours`}
        />
      );
    case BannerDecision.KeyInvalid:
      return (
        <AmberBanner
          message={`${displayName} rejected the configured credential. New ${displayName} sessions will fail until you update it.`}
          buttonLabel={`Review ${displayName} settings`}
          onClick={() =>
            credentialOwner === 'tenant' && canManageWorkspaceCredentials
              ? onOpenWorkspaceSettings('agentic-tools')
              : onOpenUserSettings(probeAgent)
          }
          onDismiss={dismissCredentialWarning}
          dismissLabel={`Snooze ${displayName} warning for 24 hours`}
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
