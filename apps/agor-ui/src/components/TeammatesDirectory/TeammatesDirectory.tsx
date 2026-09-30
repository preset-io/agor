import type { AgorClient, Branch, User } from '@agor-live/client';
import { ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons';
import { Col, Empty, Flex, Input, Row, Segmented, Skeleton, Typography, theme } from 'antd';
import { memo, useEffect, useMemo, useState } from 'react';
import { useSessionAccess } from '../../hooks/useSessionAccess';
import { useSharedTeammates } from '../../hooks/useSharedTeammates';
import { useAgorStore } from '../../store/agorStore';
import { teammateLabel } from '../../utils/teammateLabels';
import { HomeCard, HomeFrame, HomeLink } from '../HomePage/HomeSection';
import { TeammateCard, teammateOwner, teammatePurpose } from '../HomePage/HomeTeammates';

/** Case- and accent-insensitive form for search ("José" matches "jose"). */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

interface TeammatesDirectoryProps {
  client: AgorClient | null;
  currentUser?: User | null;
  /** Offer the "You can ask" filter (callers who can start sessions). */
  checkAccess?: boolean;
  onOpenBoard: (boardId: string) => void;
  /** Omitted where the shell already supplies the page header. */
  onBack?: () => void;
}

/** Every teammate shared with the caller; private teammates never appear. */
export const TeammatesDirectory = memo(function TeammatesDirectory({
  client,
  currentUser,
  checkAccess,
  onOpenBoard,
  onBack,
}: TeammatesDirectoryProps) {
  const { token } = theme.useToken();
  const hydrated = useAgorStore((s) => s.branchesHydrated);
  const {
    teammates,
    settled: sharingSettled,
    failed: sharingFailed,
    retry: retrySharing,
  } = useSharedTeammates(client, currentUser);
  const userById = useAgorStore((s) => s.userById);
  const boardById = useAgorStore((s) => s.boardById);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'ask'>('all');
  const asking = !!checkAccess && filter === 'ask';
  // The filter hides with `checkAccess`; don't leave it stuck on "You can ask".
  useEffect(() => {
    if (!checkAccess) setFilter('all');
  }, [checkAccess]);
  const branchIds = useMemo(() => teammates.map((b) => b.branch_id), [teammates]);
  // Access is read for everyone only under "You can ask"; "All" shows answers already cached.
  const {
    access,
    failedIds,
    failed: accessFailed,
    retry: retryAccess,
  } = useSessionAccess(checkAccess ? client : null, currentUser?.user_id, branchIds, {
    read: asking,
  });
  const loading = !hydrated || !sharingSettled;
  const q = fold(query.trim());
  const matches = (branch: Branch) => {
    if (!q) return true;
    const owner = userById.get(teammateOwner(branch));
    const board = branch.board_id ? boardById.get(branch.board_id) : undefined;
    return [
      teammateLabel(branch),
      teammatePurpose(branch, board),
      board?.name,
      owner?.name,
      owner?.email,
    ].some((text) => text && fold(text).includes(q));
  };
  // Under "You can ask" a card waits for every match before it, so late answers only append.
  const visible: Branch[] = [];
  let pending = 0;
  let accessFailures = 0;
  for (const branch of teammates.filter(matches)) {
    const id = branch.branch_id;
    if (!asking) visible.push(branch);
    else if (id in access) {
      if (access[id] && !pending) visible.push(branch);
    } else if (failedIds.has(id)) accessFailures++;
    else pending++;
  }
  const checking = pending > 0;
  const failed = sharingFailed + accessFailures;
  const retry = () => {
    if (sharingFailed > 0) retrySharing();
    if (accessFailed > 0) retryAccess();
  };
  const emptyText =
    teammates.length === 0
      ? 'No teammates are shared with you yet.'
      : asking && !q
        ? 'None you can ask yet.'
        : 'No teammates match.';
  const small = { fontSize: token.fontSizeSM };

  return (
    <HomeFrame maxWidth={1000}>
      {onBack && (
        <HomeLink
          icon={<ArrowLeftOutlined />}
          onClick={onBack}
          style={{ alignSelf: 'flex-start', paddingInline: 0 }}
        >
          Home
        </HomeLink>
      )}
      <div>
        {onBack && (
          <Typography.Title level={4} style={{ margin: 0 }}>
            AI teammates
          </Typography.Title>
        )}
        <Typography.Text type="secondary">
          Teammates your team shared with you. Private teammates stay private.
        </Typography.Text>
      </div>
      <HomeCard padded>
        <Flex vertical gap={token.marginSM}>
          <Flex gap={token.marginXS} wrap>
            <Input
              allowClear
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
              placeholder="Search by name, purpose, board or owner"
              aria-label="Search teammates"
              style={{ flex: '1 1 220px', minWidth: 0 }}
            />
            {checkAccess && (
              <Segmented
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'ask', label: 'You can ask' },
                ]}
              />
            )}
          </Flex>
          {visible.length === 0 ? (
            loading || checking ? (
              <div role="status" aria-label={loading ? 'Loading teammates' : 'Checking access'}>
                <Skeleton active title={false} paragraph={{ rows: 3 }} />
              </div>
            ) : (
              // The failure notice below explains an empty list better than any empty state.
              failed === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
            )
          ) : (
            <Row gutter={[token.marginSM, token.marginSM]}>
              {visible.map((branch) => (
                <Col key={branch.branch_id} xs={24} sm={12} lg={8}>
                  <HomeCard>
                    <TeammateCard
                      branch={branch}
                      viewOnly={access[branch.branch_id] === false}
                      onOpenBoard={onOpenBoard}
                    />
                  </HomeCard>
                </Col>
              ))}
            </Row>
          )}
          {visible.length > 0 && (loading || checking) && (
            <Typography.Text type="secondary" role="status" style={small}>
              {loading ? 'Loading more teammates…' : `Checking access for ${pending} more…`}
            </Typography.Text>
          )}
          {failed > 0 && (
            <Flex align="center" gap={token.marginXXS} wrap>
              <Typography.Text type="secondary" style={small}>
                Couldn’t check access for {failed} {failed === 1 ? 'teammate' : 'teammates'} ·
              </Typography.Text>
              <HomeLink onClick={retry}>Retry</HomeLink>
            </Flex>
          )}
        </Flex>
      </HomeCard>
    </HomeFrame>
  );
});
