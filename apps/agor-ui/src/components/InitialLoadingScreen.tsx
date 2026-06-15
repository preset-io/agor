import { CheckCircleFilled } from '@ant-design/icons';
import { Flex, Spin, Typography, theme } from 'antd';
import type { InitialLoadItem, LoaderPhase } from '../hooks';
import { Tag } from './Tag';

interface Props {
  phase?: LoaderPhase;
  connecting?: boolean;
  items?: InitialLoadItem[];
  message?: string;
}

export function InitialLoadingScreen({
  phase = 'loading',
  connecting = false,
  items = [],
  message,
}: Props) {
  const { token } = theme.useToken();
  const statusMessage = message ?? (connecting ? 'Connecting to daemon…' : 'Loading workspace…');
  const showItems = !connecting && items.length > 0;

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
          {items.map(({ key, label, done, count }) => (
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
                color={done ? 'success' : 'default'}
                style={{ marginInlineEnd: 0, minWidth: 28 }}
              >
                {count}
              </Tag>
            </Flex>
          ))}
        </Flex>
      )}
    </Flex>
  );
}
