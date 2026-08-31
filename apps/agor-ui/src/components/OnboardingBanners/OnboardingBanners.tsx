/**
 * OnboardingBanners — persistent banners shown after onboarding if steps were skipped.
 *
 * Priority order (only one shows at a time):
 * 1. AI warning — no credentialed tool passes the check-auth probe.
 * 2. Partial-AI notice — the governed tool is broken but another tool works.
 * 3. Integrations info — AI ok, no MCP servers and no gateway channels.
 *
 * The amber warnings require POSITIVE proof (probe Unauthenticated); the softened
 * notice additionally requires positive proof that another tool works. Decision
 * logic lives in `bannerLogic.ts`.
 */

import { AGENTIC_TOOL_DISPLAY_NAMES } from '@agor/agentic-tools';
import type { AgenticToolName, AuthCheckResult, User } from '@agor-live/client';
import { Alert, Button, Space } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import {
  BannerDecision,
  credentialFingerprint,
  credentialRemediationTarget,
  decideBanner,
  hasConfiguredCredentialFor,
  ProbeState,
  probeableTools,
  resolvedCredentialOwner,
  resolveGovernedProbeAgent,
  resolveProbeState,
} from './bannerLogic';
import {
  credentialWarningDismissalKey,
  readCredentialWarningDismissed,
  writeCredentialWarningDismissed,
} from './credentialWarningDismissal';
import {
  integrationsBannerDismissalKey,
  readIntegrationsBannerDismissed,
  writeIntegrationsBannerDismissed,
} from './integrationsBannerDismissal';

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

function CredentialBanner({
  type = 'warning',
  message,
  buttonLabel,
  onClick,
  docsHref,
  onDismiss,
  dismissLabel,
}: {
  type?: 'warning' | 'info';
  message: string;
  buttonLabel?: string;
  onClick?: () => void;
  docsHref?: string;
  onDismiss: () => void;
  dismissLabel: string;
}) {
  const hasAction = !!docsHref || (!!buttonLabel && !!onClick);
  return (
    <Alert
      banner
      showIcon
      type={type}
      title={message}
      closable={{ closeIcon: true, onClose: onDismiss, 'aria-label': dismissLabel }}
      action={
        hasAction ? (
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
            {buttonLabel && onClick && (
              <Button type="primary" size="small" onClick={onClick}>
                {buttonLabel}
              </Button>
            )}
          </Space>
        ) : undefined
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
  const [probeResult, setProbeResult] = useState<{
    owner: string;
    states: Partial<Record<AgenticToolName, ProbeState>>;
  }>({ owner: '', states: {} });
  const [integrationsBannerDismissed, setIntegrationsBannerDismissed] = useState(false);
  const [credentialWarningDismissed, setCredentialWarningDismissed] = useState(false);
  const [softWarningDismissed, setSoftWarningDismissed] = useState(false);
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
  const userCredentialRevision = user?.updated_at ? String(user.updated_at) : '';
  const warningFingerprint = credentialFingerprint(user, probeAgent, probeSettings);

  // Every enabled tool the user/tenant already has a credential for, governed
  // tool first. `probeToolsSignature` keys the memo on CONTENT so an unrelated
  // App-shell render that reallocates arrays does not re-fire the probe.
  const probeTools = probeableTools(user, agenticToolSettings);
  const probeToolsSignature = JSON.stringify(probeTools);
  const toolsToProbe = useMemo(
    () => JSON.parse(probeToolsSignature) as AgenticToolName[],
    [probeToolsSignature]
  );

  // Auth-method markers for the probed tools' subscription/native paths. They
  // land server-side via their own service and can change without a stored key
  // or credentialVersion bump. Only the derived primitives belong in the probe
  // key so a login for an unrelated tool does not re-probe this set.
  const probeAuthMethods = toolsToProbe.map((tool) =>
    tool === 'codex' || tool === 'claude-code' ? user?.agentic_auth_methods?.[tool] : undefined
  );
  const probeSettingsList = toolsToProbe.map(
    (tool) => agenticToolSettings.get(tool as never) ?? null
  );
  const probeOwner = JSON.stringify([
    userId,
    userCredentialRevision,
    onboardingCompleted,
    connectionReady,
    agenticToolSettingsHydrated,
    probeToolsSignature,
    probeSettingsList,
    credentialVersion,
    probeAuthMethods,
  ]);
  // Never render an old user's/tool's verdict for one frame while the effect
  // below is scheduling its replacement.
  const currentStates = probeResult.owner === probeOwner ? probeResult.states : {};
  const probeState = currentStates[probeAgent] ?? ProbeState.Unknown;
  const workingAlternative =
    toolsToProbe.find(
      (tool) => tool !== probeAgent && currentStates[tool] === ProbeState.Authenticated
    ) ?? null;
  const workingAlternativeName = workingAlternative
    ? (AGENTIC_TOOL_DISPLAY_NAMES[workingAlternative] ?? workingAlternative)
    : '';

  // One fan-out probe per identity/credential change. Deps are primitives/stable
  // so the effect never re-fires on board navigation or unrelated App-shell
  // renders. `updated_at`/`credentialVersion` cover a same-field rotation and
  // the local save path before realtime lands; `probeAuthMethods` re-probes
  // after a subscription/native login (device sign-in, auth.json import) that
  // bumps neither, and covers a second browser tab.
  useEffect(() => {
    if (!onboardingCompleted || !connectionReady || !agenticToolSettingsHydrated || !probeEnabled) {
      setProbeResult({ owner: probeOwner, states: {} });
      return;
    }
    setProbeResult({ owner: probeOwner, states: {} });
    let cancelled = false;
    Promise.all(
      toolsToProbe.map((tool) =>
        resolveProbeState(
          (probeTool) => onCheckAuth(probeTool).then((result) => result.status),
          tool
        )
          .then((state) => [tool, state] as const)
          .catch(() => [tool, ProbeState.Unknown] as const)
      )
    ).then((entries) => {
      if (!cancelled) {
        setProbeResult({ owner: probeOwner, states: Object.fromEntries(entries) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    onboardingCompleted,
    connectionReady,
    agenticToolSettingsHydrated,
    probeEnabled,
    onCheckAuth,
    toolsToProbe,
    probeOwner,
  ]);

  // Persistent, per-user+tool dismissals. They survive reloads and time; a stale
  // entry (the tool's credential fingerprint changed) is cleared on read, so a
  // real warning is never hidden by an out-of-date dismissal. Keyed on the
  // fingerprint so an unrelated tool's save cannot resurface this warning.
  useEffect(() => {
    if (!userId || typeof window === 'undefined') {
      setCredentialWarningDismissed(false);
      setSoftWarningDismissed(false);
      return;
    }
    setCredentialWarningDismissed(
      readCredentialWarningDismissed(
        window.localStorage,
        'warning',
        userId,
        probeAgent,
        warningFingerprint
      )
    );
    setSoftWarningDismissed(
      readCredentialWarningDismissed(
        window.localStorage,
        'partial',
        userId,
        probeAgent,
        warningFingerprint
      )
    );
  }, [userId, probeAgent, warningFingerprint]);

  useEffect(() => {
    if (!userId || typeof window === 'undefined') {
      setIntegrationsBannerDismissed(false);
      return;
    }
    setIntegrationsBannerDismissed(readIntegrationsBannerDismissed(window.localStorage, userId));
  }, [userId]);

  // localStorage writes are not delivered back to the tab that made them, but
  // other tabs receive a storage event. Mirror those so a dismissal has
  // browser-wide semantics. `event.key === null` is a full clear().
  useEffect(() => {
    if (!userId || typeof window === 'undefined') return;
    const warningKey = credentialWarningDismissalKey('warning', userId, probeAgent);
    const partialKey = credentialWarningDismissalKey('partial', userId, probeAgent);
    const integrationsKey = integrationsBannerDismissalKey(userId);
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
      if (event.key === null || event.key === warningKey) {
        setCredentialWarningDismissed(
          readCredentialWarningDismissed(
            window.localStorage,
            'warning',
            userId,
            probeAgent,
            warningFingerprint
          )
        );
      }
      if (event.key === null || event.key === partialKey) {
        setSoftWarningDismissed(
          readCredentialWarningDismissed(
            window.localStorage,
            'partial',
            userId,
            probeAgent,
            warningFingerprint
          )
        );
      }
      if (event.key === null || event.key === integrationsKey) {
        setIntegrationsBannerDismissed(
          readIntegrationsBannerDismissed(window.localStorage, userId)
        );
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [userId, probeAgent, warningFingerprint]);

  const dismissCredentialWarning = () => {
    if (!userId || typeof window === 'undefined') return;
    writeCredentialWarningDismissed(
      window.localStorage,
      'warning',
      userId,
      probeAgent,
      warningFingerprint
    );
    setCredentialWarningDismissed(true);
  };
  const dismissSoftWarning = () => {
    if (!userId || typeof window === 'undefined') return;
    writeCredentialWarningDismissed(
      window.localStorage,
      'partial',
      userId,
      probeAgent,
      warningFingerprint
    );
    setSoftWarningDismissed(true);
  };
  const dismissIntegrationsBanner = () => {
    if (userId && typeof window !== 'undefined') {
      writeIntegrationsBannerDismissed(window.localStorage, userId);
    }
    setIntegrationsBannerDismissed(true);
  };

  const decision = decideBanner({
    onboardingCompleted,
    hasLlm,
    probeState,
    hasWorkingAlternative: workingAlternative !== null,
    canManageMcp,
    mcpServerCount,
    gatewayChannelCount,
    integrationsHydrated,
    integrationsBannerDismissed,
    credentialWarningDismissed,
    softWarningDismissed,
  });
  const remediationTarget = credentialRemediationTarget(
    credentialOwner,
    probeSettings?.resolution_policy,
    canManageWorkspaceCredentials
  );
  const workspaceManagedForMember = remediationTarget === 'workspace-admin';
  const personalOverrideForWorkspaceFallback =
    credentialOwner === 'tenant' && remediationTarget === 'user';
  const openCredentialSettings = workspaceManagedForMember
    ? undefined
    : () =>
        remediationTarget === 'tenant'
          ? onOpenWorkspaceSettings('agentic-tools')
          : onOpenUserSettings(probeAgent);

  switch (decision) {
    case BannerDecision.None:
      return null;
    case BannerDecision.NoAi:
      return (
        <CredentialBanner
          message={
            workspaceManagedForMember
              ? `${displayName} is managed by your workspace but isn't connected. Ask a workspace admin to configure it before starting ${displayName} sessions.`
              : personalOverrideForWorkspaceFallback
                ? `${displayName} isn't connected through the workspace fallback. Add a personal credential to use for your ${displayName} sessions.`
                : `${displayName} isn't connected. New ${displayName} sessions won't run until you configure it.`
          }
          buttonLabel={
            workspaceManagedForMember
              ? undefined
              : personalOverrideForWorkspaceFallback
                ? `Add personal ${displayName} credential`
                : `Open ${displayName} settings`
          }
          onClick={openCredentialSettings}
          docsHref="https://agor.live/guide"
          onDismiss={dismissCredentialWarning}
          dismissLabel={`Dismiss ${displayName} warning`}
        />
      );
    case BannerDecision.KeyInvalid:
      return (
        <CredentialBanner
          message={
            workspaceManagedForMember
              ? `${displayName} rejected the workspace-managed credential. Ask a workspace admin to update it before starting new ${displayName} sessions.`
              : personalOverrideForWorkspaceFallback
                ? `${displayName} rejected the workspace fallback credential. Add a personal credential to use for your ${displayName} sessions.`
                : `${displayName} rejected the configured credential. New ${displayName} sessions will fail until you update it.`
          }
          buttonLabel={
            workspaceManagedForMember
              ? undefined
              : personalOverrideForWorkspaceFallback
                ? `Add personal ${displayName} credential`
                : `Review ${displayName} settings`
          }
          onClick={openCredentialSettings}
          onDismiss={dismissCredentialWarning}
          dismissLabel={`Dismiss ${displayName} warning`}
        />
      );
    case BannerDecision.PartialAi:
      return (
        <CredentialBanner
          type="info"
          message={`${displayName} isn't connected, but ${workingAlternativeName} is working. New ${displayName} sessions won't run until you reconnect it — your ${workingAlternativeName} sessions are unaffected.`}
          buttonLabel={
            workspaceManagedForMember
              ? undefined
              : personalOverrideForWorkspaceFallback
                ? `Add personal ${displayName} credential`
                : `Reconnect ${displayName}`
          }
          onClick={openCredentialSettings}
          onDismiss={dismissSoftWarning}
          dismissLabel={`Dismiss ${displayName} notice`}
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
              <Button type="text" size="small" onClick={dismissIntegrationsBanner}>
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
