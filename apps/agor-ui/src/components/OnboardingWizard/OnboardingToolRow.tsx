import type { AgorClient } from '@agor-live/client';
import { Button, Card, Checkbox, Flex, Typography, theme } from 'antd';
import { type MouseEvent, useEffect, useId } from 'react';
import type { OnboardingIntegrationRecommendation } from '../../utils/onboardingGoals';
import { useCatalogReadiness } from '../Marketplace/useCatalogReadiness';
import { McpLogo } from '../McpLogo';
import { Tag } from '../Tag';

interface Props {
  recommendation: OnboardingIntegrationRecommendation;
  client: AgorClient | null;
  connected: boolean;
  authGeneration: number;
  readinessRevision?: number;
  userId?: string;
  selected: boolean;
  onToggle: () => void;
  onOpen: (event: MouseEvent<HTMLElement>) => void;
}

/**
 * Visual provenance: Kasia's #2293, 637d38a7, renderIntegrations: one row,
 * 20px monochrome mark, semibold name, smaller secondary description.
 * AntD tokens/components replace the historical literal styles/List; Catalog
 * still owns auth. This hook only reads its existing caller-scoped projection.
 */
export function OnboardingToolRow({
  recommendation: rec,
  client,
  connected,
  authGeneration,
  readinessRevision = 0,
  userId,
  selected,
  onToggle,
  onOpen,
}: Props) {
  const { token } = theme.useToken();
  const titleId = useId();
  const descriptionId = useId();
  const statusId = useId();
  const catalogKey = rec.setup.surface === 'marketplace' ? rec.setup.catalogEntryName : undefined;
  const { readiness, loading, error, refresh } = useCatalogReadiness({
    client,
    entryKey: catalogKey,
    ready: connected,
    authGeneration,
    userId,
  });
  useEffect(() => {
    if (readinessRevision > 0) void refresh();
  }, [readinessRevision, refresh]);
  const name = rec.id === 'slack' ? 'Slack MCP' : rec.name;
  const state = !catalogKey
    ? 'Not available in Catalog'
    : !connected
      ? 'Reconnect to check connection'
      : loading
        ? 'Checking connection…'
        : error
          ? 'Could not check connection'
          : readiness?.state === 'installed_ready'
            ? 'Ready to use'
            : readiness?.state === 'reusable_oauth'
              ? 'Existing sign-in available'
              : readiness?.state === 'bearer_required'
                ? 'Token required'
                : readiness?.state === 'oauth_required'
                  ? 'Sign in required'
                  : readiness?.state === 'no_auth'
                    ? 'No account expected'
                    : 'Connection status unavailable';
  const action =
    rec.id === 'slack'
      ? 'Slack MCP availability'
      : rec.connectMode === 'none'
        ? 'Connect through Catalog'
        : 'Sign in through Catalog';
  return (
    <Card
      role="listitem"
      aria-labelledby={titleId}
      size="small"
      styles={{ body: { padding: token.paddingSM } }}
    >
      <Flex align="flex-start" gap={token.marginSM}>
        <Flex
          align="center"
          justify="center"
          style={{ width: token.controlHeightSM, height: token.controlHeightSM, flexShrink: 0 }}
        >
          <McpLogo id={rec.id} name={rec.name} size={token.sizeMD} color={token.colorText} />
        </Flex>
        <Flex vertical gap={token.marginXXS} style={{ minWidth: 0, flex: 1 }}>
          <Flex align="flex-start" gap="small">
            <Typography.Text
              id={titleId}
              strong
              style={{ fontSize: token.fontSize, minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}
            >
              {name}
            </Typography.Text>
            <Checkbox
              aria-label={`Suggest ${rec.name} to my teammate`}
              checked={selected}
              onChange={onToggle}
              style={{ flexShrink: 0 }}
            />
          </Flex>
          <Typography.Text
            id={descriptionId}
            type="secondary"
            style={{
              fontSize: token.fontSizeSM,
              lineHeight: token.lineHeightSM,
              overflowWrap: 'anywhere',
            }}
          >
            {rec.description}
          </Typography.Text>
          {state === 'Token required' || state === 'Sign in required' ? (
            <Tag
              id={statusId}
              color="warning"
              style={{ alignSelf: 'flex-start', marginInlineEnd: 0 }}
            >
              {state}
            </Tag>
          ) : (
            <Typography.Text id={statusId} type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {state}
            </Typography.Text>
          )}
          <Flex wrap gap="small">
            <Button
              type="link"
              aria-label={rec.id === 'slack' ? action : `${action} for ${rec.name}`}
              aria-describedby={`${descriptionId} ${statusId}`}
              aria-haspopup="dialog"
              onClick={onOpen}
              style={{
                paddingLeft: 0,
                paddingInlineStart: 0,
                whiteSpace: 'normal',
                height: 'auto',
                minHeight: token.controlHeight,
                fontSize: token.fontSizeSM,
                textAlign: 'left',
              }}
            >
              {action}
            </Button>
            {error && connected && (
              <Button
                type="link"
                aria-label={`Retry connection check for ${rec.name}`}
                onClick={() => void refresh()}
                style={{ paddingLeft: 0, paddingInlineStart: 0, fontSize: token.fontSizeSM }}
              >
                Retry
              </Button>
            )}
          </Flex>
        </Flex>
      </Flex>
    </Card>
  );
}
