import type { Session } from '@agor-live/client';
import { HistoryOutlined, ImportOutlined } from '@ant-design/icons';
import { Divider, Flex, Typography, theme } from 'antd';
import { fill, PACK_COPY } from './packCopy';

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

/** "Imported from Community Edition on Oct 28", above an imported transcript. */
export const ImportedSessionLine: React.FC<{ session: Session }> = ({ session }) => {
  const imported = (session.custom_context as { import?: { imported_at?: string } } | undefined)
    ?.import?.imported_at;
  const date = new Date(imported ?? session.created_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return (
    <Divider plain style={{ margin: '4px 0 12px' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <ImportOutlined /> {fill(PACK_COPY.impLine, { date })}
      </Typography.Text>
    </Divider>
  );
};
