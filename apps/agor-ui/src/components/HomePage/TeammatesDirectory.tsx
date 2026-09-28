import type { AgorClient, User } from '@agor-live/client';
import { ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons';
import { Col, Empty, Flex, Input, Row, Segmented, Skeleton, Typography, theme } from 'antd';
import { memo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { teammateLabel } from '../../utils/teammateLabels';
import { HomeCard, HomeFrame, HomeLink } from './HomeSection';
import {
  TeammateCard,
  teammateOwner,
  teammatePurpose,
  useSessionAccess,
  useSharedTeammates,
} from './HomeTeammates';

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
  const teammates = useSharedTeammates(client, currentUser);
  const userById = useAgorStore((s) => s.userById);
  const boardById = useAgorStore((s) => s.boardById);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'ask'>('all');
  // Access is read for everyone only when the viewer asks for "You can ask".
  const { access, settled } = useSessionAccess(
    filter === 'ask' && checkAccess ? client : null,
    currentUser?.user_id,
    teammates.map((b) => b.branch_id)
  );
  const q = query.trim().toLowerCase();
  const visible = teammates.filter((branch) => {
    if (filter === 'ask' && !access[branch.branch_id]) return false;
    if (!q) return true;
    const owner = userById.get(teammateOwner(branch));
    const board = branch.board_id ? boardById.get(branch.board_id) : undefined;
    return [teammateLabel(branch), teammatePurpose(branch, board), owner?.name, owner?.email].some(
      (text) => text?.toLowerCase().includes(q)
    );
  });

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
              placeholder="Search by name, purpose or owner"
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
          {filter === 'ask' && !settled ? (
            <div role="status" aria-label="Checking access">
              <Skeleton active title={false} paragraph={{ rows: 3 }} />
            </div>
          ) : visible.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No teammates match." />
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
        </Flex>
      </HomeCard>
    </HomeFrame>
  );
});
