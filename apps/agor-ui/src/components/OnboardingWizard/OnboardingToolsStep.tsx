import type { AgorClient, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Alert, Button, Flex, Spin, Typography, theme } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';
import type { OnboardingIntegrationRecommendation } from '../../utils/onboardingGoals';
import {
  type OnboardingSlackGatewayIntent,
  readOnboardingSlackGateways,
} from '../../utils/onboardingSlack';
import { CatalogTab } from '../Marketplace/CatalogTab';
import { OnboardingRecommendationCard } from './OnboardingRecommendationCard';
import { OnboardingToolRow } from './OnboardingToolRow';

interface Props {
  client: AgorClient | null;
  user?: User | null;
  connected: boolean;
  authGeneration: number;
  kit: OnboardingIntegrationRecommendation[];
  isSelected: (id: string) => boolean;
  onToggle: (id: string) => void;
  onConnected: (serverId: string) => void;
  gatewayIntent: OnboardingSlackGatewayIntent;
  onGatewayIntent: (intent: OnboardingSlackGatewayIntent) => void;
}

function ToolsForIdentity(props: Props) {
  const { token } = theme.useToken();
  const {
    client,
    user,
    connected,
    authGeneration,
    kit,
    isSelected,
    onToggle,
    gatewayIntent,
    onGatewayIntent,
  } = props;
  const [readinessRevision, setReadinessRevision] = useState(0);
  const [entry, setEntry] = useState<string>();
  const trigger = useRef<HTMLElement | null>(null);
  const [gateways, setGateways] =
    useState<Awaited<ReturnType<typeof readOnboardingSlackGateways>>>();
  const [gatewayError, setGatewayError] = useState(false);
  const [retry, setRetry] = useState(0);
  const slack = kit.find((rec) => rec.id === 'slack');
  const hasSlack = !!slack;
  const slackDescriptionId = useId();
  const slackSelected = hasSlack && isSelected('slack');
  const canRequestGateway =
    slackSelected &&
    !!client &&
    connected &&
    !gatewayError &&
    gateways?.length === 0 &&
    hasMinimumRole(user?.role, ROLES.ADMIN);
  useEffect(() => {
    // The single selection is an opt-in to assistance, not resource creation.
    // Completion still rechecks the caller's role and fresh scoped inventory.
    const intent = canRequestGateway ? 'request-new' : 'prefer-existing';
    if (gatewayIntent !== intent) onGatewayIntent(intent);
  }, [canRequestGateway, gatewayIntent, onGatewayIntent]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly refreshes the permission-scoped inventory
  useEffect(() => {
    if (!client || !connected || !hasSlack) return;
    let cancelled = false;
    setGateways(undefined);
    setGatewayError(false);
    void readOnboardingSlackGateways(client)
      .then((value) => {
        if (!cancelled) setGateways(value);
      })
      .catch(() => {
        if (!cancelled) setGatewayError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, connected, hasSlack, retry]);
  const close = () => {
    setEntry(undefined);
    const source = trigger.current;
    requestAnimationFrame(() => {
      if (source?.isConnected) source.focus();
    });
  };
  return (
    <Flex vertical gap="small">
      <Typography.Paragraph type="secondary" style={{ fontSize: token.fontSizeSM }}>
        Connect tools here without leaving setup. Connections are optional. Connect saves only your
        MCP connection; Back and Skip do not delete saved connections.
      </Typography.Paragraph>
      <Flex vertical role="list" aria-label="Suggested MCP tools" gap={token.marginXS}>
        {kit
          .filter((rec) => rec.setup.surface !== 'slack')
          .map((rec) => (
            <OnboardingToolRow
              key={rec.id}
              readinessRevision={readinessRevision}
              recommendation={rec}
              client={client}
              userId={user?.user_id}
              connected={connected}
              authGeneration={authGeneration}
              selected={isSelected(rec.id)}
              onToggle={() => onToggle(rec.id)}
              onOpen={(event) => {
                trigger.current = event.currentTarget;
                if (rec.setup.surface === 'marketplace') setEntry(rec.setup.catalogEntryName);
              }}
            />
          ))}
      </Flex>
      {slack && (
        <OnboardingRecommendationCard
          recommendation={slack}
          descriptionId={slackDescriptionId}
          selected={slackSelected}
          onToggle={() => onToggle('slack')}
        >
          {!connected ? (
            <Alert type="info" title="Reconnect to check Slack gateways." />
          ) : gatewayError ? (
            <Alert
              type="warning"
              title="Could not check Slack gateways"
              action={<Button onClick={() => setRetry((value) => value + 1)}>Retry</Button>}
            />
          ) : !gateways ? (
            <Spin aria-label="Checking Slack gateways" />
          ) : gateways.length ? (
            <>
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                Prefer your existing Slack gateway:{' '}
                {gateways.map((gateway) => gateway.name).join(', ')}.
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                It continues to serve its current teammate. We will not retarget it or create a
                duplicate. Your new teammate must not use another branch’s gateway.
              </Typography.Text>
            </>
          ) : hasMinimumRole(user?.role, ROLES.ADMIN) ? (
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              No usable Slack gateway found. Your teammate can help create one if permissions allow.
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              No usable Slack gateway found. An administrator must create one; no new gateway will
              be requested.
            </Typography.Text>
          )}
        </OnboardingRecommendationCard>
      )}
      {entry && (
        <CatalogTab
          client={client}
          currentUser={user}
          connected={connected}
          connecting={!connected}
          authGeneration={authGeneration}
          context={{
            mode: 'onboarding',
            entryName: entry,
            onClose: close,
            onConnected: (serverId) => {
              props.onConnected(serverId);
              setReadinessRevision((value) => value + 1);
            },
          }}
        />
      )}
    </Flex>
  );
}

/** Replacement identity/auth generation destroys drawers and any retained private input. */
export function OnboardingToolsStep(props: Props) {
  return (
    <ToolsForIdentity
      key={`${props.user?.user_id}:${props.user?.role}:${props.authGeneration}:${props.connected}`}
      {...props}
    />
  );
}
