import type { AgorClient, Branch, Link } from '@agor-live/client';
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Space, Typography } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useAgorStore } from '../../../store/agorStore';
import {
  makeLinksForBranchSelector,
  selectApplyLinkMutationResult,
  selectFetchAndReplaceFullBranchLinks,
} from '../../../store/selectors';
import { useThemedMessage } from '../../../utils/message';
import { buildLinkDisplayItems, getLinkCategorySummary, LinkDisplayList } from '../../Links';

interface LinksTabProps {
  branch: Branch;
  client: AgorClient | null;
  active: boolean;
  open: boolean;
}

export const LinksTab: React.FC<LinksTabProps> = ({ branch, client, active, open }) => {
  const selector = useMemo(() => makeLinksForBranchSelector(branch.branch_id), [branch.branch_id]);
  const links = useAgorStore(selector) ?? [];
  const fetchAndReplaceFullBranchLinks = useAgorStore(selectFetchAndReplaceFullBranchLinks);
  const applyLinkMutationResult = useAgorStore(selectApplyLinkMutationResult);
  const { showError } = useThemedMessage();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pinningLinkId, setPinningLinkId] = useState<string | null>(null);

  const displayItems = useMemo(() => buildLinkDisplayItems({ branch, links }), [branch, links]);

  useEffect(() => {
    if (!open || !active || !client) return;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchAndReplaceFullBranchLinks(client, branch.branch_id)
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setLoadError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [active, branch.branch_id, client, fetchAndReplaceFullBranchLinks, open]);

  const refresh = async () => {
    if (!client) return;
    setLoading(true);
    setLoadError(null);
    try {
      await fetchAndReplaceFullBranchLinks(client, branch.branch_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePinned = async (item: { linkId?: string; isPinned: boolean }) => {
    if (!client || !item.linkId) return;
    setPinningLinkId(item.linkId);
    try {
      const updated = (await client.service('links').patch(item.linkId, {
        is_pinned: !item.isPinned,
      })) as Link;
      applyLinkMutationResult(updated);
    } catch (error) {
      showError(`Failed to update link: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPinningLinkId(null);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <Card
        title="Links"
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={refresh}
            loading={loading}
            disabled={!client}
          >
            Refresh
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {displayItems.length > 0
              ? getLinkCategorySummary(displayItems)
              : 'Branch issue, PR, and saved branch links will appear here.'}
          </Typography.Text>
          {loadError && (
            <Alert type="warning" showIcon message="Failed to load links" description={loadError} />
          )}
          <LinkDisplayList
            items={displayItems}
            emptyDescription="No branch links yet"
            showPinActions
            pinActionDisabled={!client}
            pinningLinkId={pinningLinkId}
            onTogglePinned={handleTogglePinned}
          />
        </Space>
      </Card>
    </div>
  );
};

export default LinksTab;
