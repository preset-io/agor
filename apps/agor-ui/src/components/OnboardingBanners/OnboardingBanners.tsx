/**
 * Optional post-onboarding reminders, not an agent-health dashboard.
 * Check only the tool New Session initially selects. Never infer another tool's
 * health or promise that a session will run. Dismissal is a browser-local opt-out
 * for this workspace user/tool, including future credential changes and failures.
 */

import { AGENTIC_TOOL_DISPLAY_NAMES } from '@agor/agentic-tools';
import type {
  AgenticToolName,
  AuthCheckResult,
  TenantAgenticToolSettings,
  User,
} from '@agor-live/client';
import { CloseOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Space, Tooltip, theme } from 'antd';
import { type ReactNode, useEffect, useState } from 'react';
import { useMCPCatalogModal } from '../../contexts/MCPCatalogModalContext';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useUserLocalStorage } from '../../hooks/useUserLocalStorage';
import { useAgorStore } from '../../store/agorStore';
import {
  BannerDecision,
  credentialRemediationTarget,
  decideBanner,
  hasConfiguredCredentialFor,
  ProbeState,
  resolvedCredentialOwner,
  resolveGovernedProbeAgent,
  resolveProbeState,
} from './bannerLogic';

const INTEGRATIONS_SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface OnboardingBannersProps {
  user: User | null | undefined;
  /** Current caller-visible inventories, not counts of working integrations. */
  mcpServerCount: number;
  gatewayChannelCount: number;
  integrationsHydrated: boolean;
  /** Whether the caller can complete workspace integration setup. */
  canManageMcp: boolean;
  onOpenUserSettings: (tab: string) => void;
  onOpenWorkspaceSettings: (tab: string) => void;
  /** Open the existing catalog, not workspace credential settings. */
  onOpenCatalog?: () => void;
  /** Passive server-side check; native login may deliberately remain unknown. */
  onCheckAuth: (tool: AgenticToolName, apiKey?: string) => Promise<AuthCheckResult>;
  /** Re-probe after local saves, even when credential presence is unchanged. */
  credentialVersion: number;
  connectionReady: boolean;
  /** Retire in-flight results when authenticated authority is replaced. */
  authenticationGeneration?: number;
}

function ReminderBanner({
  message,
  action,
  type = 'warning',
  onDismiss,
  dismissLabel,
}: {
  message: string;
  action?: ReactNode;
  type?: 'warning' | 'info';
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  const { token } = theme.useToken();
  return (
    <Alert
      banner
      showIcon
      type={type}
      role="status"
      styles={{ section: { minWidth: 0 } }}
      title={
        <Flex align="center" wrap gap="small">
          {/* Reserve room for copy; actions wrap below it instead of squeezing
              the message into a few characters per line on narrow screens. */}
          <span style={{ flex: `1 1 ${token.screenSM / 2}px` }}>{message}</span>
          {action}
        </Flex>
      }
      closable={
        onDismiss && {
          closeIcon: (
            <Tooltip title={dismissLabel}>
              <CloseOutlined />
            </Tooltip>
          ),
          onClose: onDismiss,
          'aria-label': dismissLabel,
        }
      }
    />
  );
}

export function OnboardingBanners(props: OnboardingBannersProps) {
  const settings = useAgorStore((state) => state.agenticToolSettingsByName);
  const hydrated = useAgorStore((state) => state.agenticToolSettingsHydrated);
  const { user } = props;
  if (!user) return null;

  const probeAgent = resolveGovernedProbeAgent(user, settings);
  // User IDs are globally unique tenant-owned rows. Public User DTOs do not
  // expose tenant_id; use that existing ownership boundary, not a new claim.
  const owner = user.user_id;
  return (
    <OwnedOnboardingBanners
      {...props}
      key={JSON.stringify([owner, probeAgent, props.authenticationGeneration])}
      user={user}
      owner={owner}
      probeAgent={probeAgent}
      probeSettings={settings.get(probeAgent)}
      policyHydrated={hydrated}
    />
  );
}

function OwnedOnboardingBanners({
  user,
  owner,
  probeAgent,
  probeSettings,
  policyHydrated,
  mcpServerCount,
  gatewayChannelCount,
  integrationsHydrated,
  canManageMcp,
  onOpenUserSettings,
  onOpenWorkspaceSettings,
  onCheckAuth,
  onOpenCatalog,
  credentialVersion,
  connectionReady,
}: OnboardingBannersProps & {
  user: User;
  owner: string;
  probeAgent: AgenticToolName;
  probeSettings?: TenantAgenticToolSettings;
  policyHydrated: boolean;
}) {
  const catalog = useMCPCatalogModal();
  const isMobile = useIsMobileViewport();
  const [integrationsSnoozedUntil, setIntegrationsSnoozedUntil] = useUserLocalStorage<
    number | null
  >(user?.user_id, 'onboarding:integrations-snoozed-until:v1', null);
  const integrationsBannerDismissed =
    typeof integrationsSnoozedUntil === 'number' &&
    Number.isFinite(integrationsSnoozedUntil) &&
    integrationsSnoozedUntil > Date.now() &&
    integrationsSnoozedUntil <= Date.now() + INTEGRATIONS_SNOOZE_MS;

  useEffect(() => {
    if (!integrationsBannerDismissed || integrationsSnoozedUntil === null) return;
    const timer = window.setTimeout(
      () => setIntegrationsSnoozedUntil(null),
      Math.min(integrationsSnoozedUntil - Date.now(), 2_147_483_647)
    );
    return () => window.clearTimeout(timer);
  }, [integrationsBannerDismissed, integrationsSnoozedUntil, setIntegrationsSnoozedUntil]);
  // The keyed parent keeps useLocalStorage keys stable for this mount. No
  // fingerprint, snooze expiry, recovery invalidation or per-tool revision:
  // "Don't remind me" stays respected, even after a different credential save.
  const [warningOptOut, setWarningOptOut] = useLocalStorage<boolean>(
    `agor:onboarding:v3:${owner}:${probeAgent}:dismissed`,
    false
  );
  // localStorage isn't typed/trusted at runtime. Only an explicit true opts out.
  const warningDismissed = warningOptOut === true;
  const [probeResult, setProbeResult] = useState<{ owner: string; state: ProbeState }>({
    owner: '',
    state: ProbeState.Unknown,
  });
  const onboardingCompleted = !!user.onboarding_completed;
  const probeEnabled = probeSettings?.enabled !== false;
  const probeAuthMethod =
    probeAgent === 'codex' || probeAgent === 'claude-code'
      ? user.agentic_auth_methods?.[probeAgent]
      : undefined;
  const probeOwner = JSON.stringify([
    user.updated_at,
    onboardingCompleted,
    connectionReady,
    policyHydrated,
    probeSettings,
    credentialVersion,
    probeAuthMethod,
    warningDismissed,
  ]);
  const probeState = probeResult.owner === probeOwner ? probeResult.state : ProbeState.Unknown;

  useEffect(() => {
    setProbeResult({ owner: probeOwner, state: ProbeState.Unknown });
    if (
      !onboardingCompleted ||
      !connectionReady ||
      !policyHydrated ||
      !probeEnabled ||
      warningDismissed
    ) {
      return;
    }
    let cancelled = false;
    resolveProbeState((tool) => onCheckAuth(tool).then((result) => result.status), probeAgent)
      .catch(() => ProbeState.Unknown)
      .then((state) => {
        if (!cancelled) setProbeResult({ owner: probeOwner, state });
      });
    return () => {
      cancelled = true;
    };
  }, [
    onboardingCompleted,
    connectionReady,
    policyHydrated,
    probeEnabled,
    warningDismissed,
    onCheckAuth,
    probeAgent,
    probeOwner,
  ]);

  const decision = decideBanner({
    onboardingCompleted,
    hasLlm: hasConfiguredCredentialFor(user, probeAgent, probeSettings),
    probeState,
    canManageMcp,
    mcpServerCount,
    gatewayChannelCount,
    integrationsHydrated,
    integrationsBannerDismissed,
    credentialWarningDismissed: warningDismissed,
  });
  if (decision === BannerDecision.None) return null;
  if (decision === BannerDecision.Integrations) {
    const integrationsMessage =
      'Connect Slack, GitHub, or other tools via MCP to let your AI post updates and track issues.';
    const integrationsActions = (
      <Space size="small" wrap={isMobile}>
        <Button
          type="text"
          size="small"
          title="Hide this reminder for 24 hours"
          onClick={() => setIntegrationsSnoozedUntil(Date.now() + INTEGRATIONS_SNOOZE_MS)}
        >
          Maybe later
        </Button>
        <Button
          type="primary"
          size="small"
          onClick={onOpenCatalog ?? (() => catalog?.openCatalog())}
        >
          Browse the catalog
        </Button>
      </Space>
    );
    return isMobile ? (
      <Alert
        banner
        showIcon
        type="info"
        title={
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <span>{integrationsMessage}</span>
            {integrationsActions}
          </Space>
        }
      />
    ) : (
      <Alert banner showIcon type="info" title={integrationsMessage} action={integrationsActions} />
    );
  }

  const displayName = AGENTIC_TOOL_DISPLAY_NAMES[probeAgent] ?? probeAgent;
  const credentialOwner = resolvedCredentialOwner(user, probeAgent, probeSettings);
  const remediationTarget = credentialRemediationTarget(
    credentialOwner,
    probeSettings?.resolution_policy,
    user.role === 'admin' || user.role === 'superadmin'
  );
  const needsAdmin = remediationTarget === 'workspace-admin';
  const personalOverride = credentialOwner === 'tenant' && remediationTarget === 'user';
  const message =
    decision === BannerDecision.NoAi
      ? `${displayName} isn't connected.`
      : `${displayName} rejected the ${credentialOwner === 'tenant' ? (personalOverride ? 'workspace fallback' : 'workspace-managed') : 'configured'} credential.`;
  const guidance = needsAdmin
    ? ' Ask a workspace admin to update it.'
    : personalOverride
      ? ' Add a personal credential to override the workspace fallback.'
      : '';
  const actionLabel = personalOverride
    ? 'Add personal credential'
    : decision === BannerDecision.NoAi
      ? 'Open settings'
      : 'Review settings';
  const actionName = personalOverride
    ? `Add personal ${displayName} credential`
    : decision === BannerDecision.NoAi
      ? `Open ${displayName} settings`
      : `Review ${displayName} settings`;
  return (
    <ReminderBanner
      message={message + guidance}
      dismissLabel={`Don't remind me about ${displayName}`}
      onDismiss={() => setWarningOptOut(true)}
      action={
        !needsAdmin && (
          <Button
            type="primary"
            size="small"
            aria-label={actionName}
            onClick={() =>
              remediationTarget === 'tenant'
                ? onOpenWorkspaceSettings('agentic-tools')
                : onOpenUserSettings(probeAgent)
            }
          >
            {actionLabel}
          </Button>
        )
      }
    />
  );
}
