import { CheckCircleFilled } from '@ant-design/icons';
import { Button, Flex, Spin, Typography, theme } from 'antd';
import { useState } from 'react';
import type {
  InitialLoadItem,
  InitialLoadItemKey,
  InitialLoadingStage,
  LoaderPhase,
} from '../hooks';
import { Tag } from './Tag';

const PRIMARY_INITIAL_LOAD_ITEMS = new Set<InitialLoadItemKey>([
  'sessions',
  'branches',
  'boards',
  'repos',
  'users',
]);

interface Props {
  phase?: LoaderPhase;
  connecting?: boolean;
  loadingStage?: InitialLoadingStage;
  items?: InitialLoadItem[];
  message?: string;
}

export function InitialLoadingScreen({
  phase = 'loading',
  connecting = false,
  loadingStage = 'fetching',
  items = [],
  message,
}: Props) {
  const { token } = theme.useToken();
  const [showDetails, setShowDetails] = useState(false);
  const statusMessage =
    message ??
    (connecting
      ? 'Connecting to daemon…'
      : loadingStage === 'indexing'
        ? 'Indexing workspace data…'
        : 'Loading workspace data…');
  const showItems = !connecting && items.length > 0;
  const primaryItems = items.filter((item) => PRIMARY_INITIAL_LOAD_ITEMS.has(item.key));
  const detailItems = items.filter((item) => !PRIMARY_INITIAL_LOAD_ITEMS.has(item.key));
  const loadedDetailItems = detailItems.filter((item) => item.done).length;
  const pendingDetailItems = detailItems.length - loadedDetailItems;
  const showDetailsLabel =
    pendingDetailItems > 0
      ? `Show details (${pendingDetailItems} pending)`
      : `Show details (${loadedDetailItems}/${detailItems.length} loaded)`;

  const renderLoadItem = ({ key, label, done, count }: InitialLoadItem) => (
    <Flex key={key} align="center" justify="space-between" gap={token.sizeSM}>
      <Flex align="center" gap={token.sizeSM}>
        <Flex align="center" justify="center" style={{ width: token.sizeMD }}>
          {done ? (
            <CheckCircleFilled style={{ color: token.colorSuccess }} />
          ) : (
            <Spin size="small" />
          )}
        </Flex>
        <Typography.Text type={done ? 'secondary' : undefined} disabled={!done}>
          {label}
        </Typography.Text>
      </Flex>
      <Tag
        color={done ? 'success' : undefined}
        variant="filled"
        style={{ marginInlineEnd: 0, minWidth: 28, textAlign: 'center' }}
      >
        {count}
      </Tag>
    </Flex>
  );

  return (
    <Flex
      vertical
      align="center"
      justify="center"
      style={{
        minHeight: '100vh',
        backgroundColor: token.colorBgLayout,
        opacity: phase === 'fading' ? 0 : 1,
        transition: 'opacity 280ms ease-out',
      }}
    >
      <Spin size="large" />
      <Typography.Text type="secondary" style={{ marginTop: token.marginMD }}>
        {statusMessage}
      </Typography.Text>
      {showItems && (
        <Flex vertical gap={token.sizeXXS} style={{ marginTop: token.marginLG, minWidth: 200 }}>
          {primaryItems.map(renderLoadItem)}
          {detailItems.length > 0 && (
            <>
              <Button
                type="link"
                size="small"
                onClick={() => setShowDetails((value) => !value)}
                style={{ alignSelf: 'center', paddingInline: 0 }}
              >
                {showDetails ? 'Hide details' : showDetailsLabel}
              </Button>
              {showDetails && detailItems.map(renderLoadItem)}
            </>
          )}
        </Flex>
      )}
    </Flex>
  );
}
