import type { AgorClient, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Alert, Button, Card, Checkbox, Flex, Spin, Typography, theme } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { OnboardingIntegrationRecommendation } from '../../utils/onboardingGoals';
import {
  type OnboardingSlackGatewayIntent,
  readOnboardingSlackGateways,
} from '../../utils/onboardingSlack';
import { CatalogDrawer } from '../Marketplace/CatalogDrawer';
import { CatalogTab } from '../Marketplace/CatalogTab';
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
  const [slackOpen, setSlackOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const [gateways, setGateways] =
    useState<Awaited<ReturnType<typeof readOnboardingSlackGateways>>>();
  const [gatewayError, setGatewayError] = useState(false);
  const [retry, setRetry] = useState(0);
  const hasSlack = kit.some((rec) => rec.id === 'slack');
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
    setSlackOpen(false);
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
        {kit.map((rec) => (
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
              else if (rec.id === 'slack') setSlackOpen(true);
            }}
          />
        ))}
      </Flex>
      {hasSlack && (
        <Card size="small" title="Slack gateway messaging">
          <Typography.Paragraph>
            Message a teammate through a Slack bot. This is separate from Slack MCP tool access.
          </Typography.Paragraph>
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
              <Typography.Paragraph>
                Prefer your existing Slack gateway:{' '}
                {gateways.map((gateway) => gateway.name).join(', ')}.
              </Typography.Paragraph>
              <Typography.Text type="secondary">
                It continues to serve its current teammate. We will not retarget it or create a
                duplicate. Your new teammate must not use another branch’s gateway.
              </Typography.Text>
            </>
          ) : hasMinimumRole(user?.role, ROLES.ADMIN) ? (
            <Checkbox
              checked={gatewayIntent === 'request-new'}
              onChange={(event) =>
                onGatewayIntent(event.target.checked ? 'request-new' : 'prefer-existing')
              }
            >
              Ask my teammate to help create a new Slack gateway
            </Checkbox>
          ) : (
            <Typography.Text type="secondary">
              No usable Slack gateway found. An administrator must create one; no new gateway will
              be requested.
            </Typography.Text>
          )}
        </Card>
      )}
      <CatalogDrawer open={slackOpen} title="Slack MCP" onClose={close}>
        <Alert
          type="info"
          title="Slack MCP is not currently available in Catalog"
          description="Slack requires a registered internal or approved Slack app with client credentials and does not support dynamic client registration. Agor has no reviewed public OAuth client for this entry, so we cannot offer working Catalog sign-in yet."
        />
        <Typography.Paragraph>
          Use an already configured, approved Slack MCP server through Agor’s existing MCP settings.
          Do not register a generic connector or use a Slack gateway bot/app token as an MCP
          credential. A gateway connection does not grant Slack MCP access.
        </Typography.Paragraph>
        <Typography.Link
          href="https://docs.slack.dev/ai/slack-mcp-server/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Official Slack MCP requirements
        </Typography.Link>
        <Button onClick={close}>Return to onboarding</Button>
      </CatalogDrawer>
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
