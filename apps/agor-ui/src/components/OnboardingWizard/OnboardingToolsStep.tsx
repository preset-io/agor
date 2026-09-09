import type { AgorClient, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Alert, Button, Card, Checkbox, Drawer, Flex, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { OnboardingIntegrationRecommendation } from '../../utils/onboardingGoals';
import {
  type OnboardingSlackGatewayIntent,
  readOnboardingSlackGateways,
} from '../../utils/onboardingSlack';
import { CatalogTab } from '../Marketplace/CatalogTab';
import { McpLogo } from '../McpLogo';

interface Props {
  client: AgorClient | null;
  user?: User | null;
  connected: boolean;
  authGeneration: number;
  kit: OnboardingIntegrationRecommendation[];
  isSelected: (id: string) => boolean;
  onToggle: (id: string) => void;
  prepareBranch: () => Promise<string>;
  onConnected: (serverId: string) => void;
  gatewayIntent: OnboardingSlackGatewayIntent;
  onGatewayIntent: (intent: OnboardingSlackGatewayIntent) => void;
}

function ToolsForIdentity(props: Props) {
  const {
    client,
    user,
    connected,
    authGeneration,
    kit,
    isSelected,
    onToggle,
    prepareBranch,
    gatewayIntent,
    onGatewayIntent,
  } = props;
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
      <Typography.Paragraph type="secondary">
        Connect tools here without leaving setup. Connections are optional. Each Connect saves a
        tool session in your teammate workspace; Back and Skip do not delete saved connections.
      </Typography.Paragraph>
      {kit.map((rec) => (
        <Card
          key={rec.id}
          size="small"
          title={
            <Flex align="center" gap="small">
              <McpLogo id={rec.id} name={rec.name} size={20} />
              {rec.id === 'slack' ? 'Slack MCP' : rec.name}
            </Flex>
          }
          extra={
            <Checkbox
              aria-label={`Suggest ${rec.name} to my teammate`}
              checked={isSelected(rec.id)}
              onChange={() => onToggle(rec.id)}
            />
          }
        >
          <Typography.Paragraph type="secondary">{rec.description}</Typography.Paragraph>
          <Button
            type="link"
            onClick={(event) => {
              trigger.current = event.currentTarget;
              if (rec.setup.surface === 'marketplace') setEntry(rec.setup.catalogEntryName);
              else if (rec.id === 'slack') setSlackOpen(true);
            }}
          >
            {rec.id === 'slack'
              ? 'Slack MCP availability'
              : rec.connectMode === 'none'
                ? 'Connect through Catalog'
                : 'Sign in through Catalog'}
          </Button>
        </Card>
      ))}
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
      <Drawer open={slackOpen} title="Slack MCP" onClose={close} destroyOnHidden>
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
      </Drawer>
      {entry && (
        <CatalogTab
          client={client}
          currentUser={user}
          connected={connected}
          connecting={!connected}
          authGeneration={authGeneration}
          initialSelection={{ entryName: entry }}
          onboarding={{ prepareBranch, onClose: close, onConnected: props.onConnected }}
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
