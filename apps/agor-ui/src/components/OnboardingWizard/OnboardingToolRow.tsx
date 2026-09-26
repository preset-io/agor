import type { AgorClient } from '@agor-live/client';
import { Typography, theme } from 'antd';
import { type MouseEvent, useEffect, useId } from 'react';
import type { OnboardingIntegrationRecommendation } from '../../utils/onboardingGoals';
import { useCatalogReadiness } from '../Marketplace/useCatalogReadiness';
import { Tag } from '../Tag';
import {
  OnboardingRecommendationCard,
  OnboardingToolAction,
  OnboardingToolActions,
} from './OnboardingRecommendationCard';

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
    <OnboardingRecommendationCard
      recommendation={rec}
      name={name}
      descriptionId={descriptionId}
      selected={selected}
      onToggle={onToggle}
      listItem
      // Keep refresh/error status in the header too: window-focus invalidation
      // must not insert a row above the action during a native pointer click.
      titleExtra={
        state === 'Token required' || state === 'Sign in required' ? (
          <Tag id={statusId} color="default" style={{ marginInlineEnd: 0 }}>
            {state}
          </Tag>
        ) : (
          <Typography.Text id={statusId} type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {state}
          </Typography.Text>
        )
      }
    >
      <OnboardingToolActions>
        <OnboardingToolAction
          type="link"
          aria-label={rec.id === 'slack' ? action : `${action} for ${rec.name}`}
          aria-describedby={`${descriptionId} ${statusId}`}
          aria-haspopup="dialog"
          onClick={onOpen}
        >
          {action}
        </OnboardingToolAction>
        {error && connected && (
          <OnboardingToolAction
            type="link"
            aria-label={`Retry connection check for ${rec.name}`}
            onClick={() => void refresh()}
          >
            Retry
          </OnboardingToolAction>
        )}
      </OnboardingToolActions>
    </OnboardingRecommendationCard>
  );
}
