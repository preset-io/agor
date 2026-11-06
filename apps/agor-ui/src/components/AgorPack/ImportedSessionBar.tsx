import { HistoryOutlined } from '@ant-design/icons';
import { Flex, Typography, theme } from 'antd';
import { PACK_COPY } from './packCopy';

/** In place of the composer on imported (read-only) history. */
export const ImportedSessionBar: React.FC = () => {
  const { token } = theme.useToken();
  return (
    <Flex
      role="status"
      align="center"
      gap={8}
      style={{
        flexShrink: 0,
        padding: `${token.paddingSM}px ${token.padding}px`,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorFillQuaternary,
      }}
    >
      <HistoryOutlined style={{ color: token.colorTextSecondary }} />
      <Typography.Text type="secondary">{PACK_COPY.impBar}</Typography.Text>
    </Flex>
  );
};
