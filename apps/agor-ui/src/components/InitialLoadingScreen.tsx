import { CheckCircleFilled } from '@ant-design/icons';
import { Button, Flex, Spin, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import type {
  InitialLoadItem,
  InitialLoadItemKey,
  InitialLoadingStage,
  LoaderPhase,
} from '../hooks';
import { LOADER_FADE_MS } from '../hooks/useInitialLoaderPhase';
import { AgorLogoSpinner } from './AgorLogoSpinner/AgorLogoSpinner';
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
  /**
   * Cover the (already mounted) workspace while fading out, without taking
   * pointer events, instead of occupying the page.
   */
  overlay?: boolean;
}

export function InitialLoadingScreen({
  phase = 'loading',
  connecting = false,
  loadingStage = 'fetching',
  items = [],
  message,
  overlay = false,
}: Props) {
  const { token } = theme.useToken();
  const [showDetails, setShowDetails] = useState(false);
  // An overlay mounts already fading; flip its opacity after the first frame
  // has painted so the transition runs instead of snapping to transparent.
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    if (phase !== 'fading') {
      setFaded(false);
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setFaded(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [phase]);
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
      data-testid="initial-loading-screen"
      style={{
        minHeight: '100vh',
        backgroundColor: token.colorBgLayout,
        opacity: phase === 'done' || faded ? 0 : 1,
        transition: `opacity ${LOADER_FADE_MS}ms ease-out`,
        ...(overlay
          ? {
              position: 'fixed',
              inset: 0,
              zIndex: token.zIndexPopupBase + 100,
              pointerEvents: 'none',
            }
          : {}),
      }}
    >
      <AgorLogoSpinner size={96} />
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
