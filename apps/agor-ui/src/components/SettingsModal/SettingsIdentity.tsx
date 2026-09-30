import { InfoCircleOutlined } from '@ant-design/icons';
import { Button, Flex, Popover, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { HighlightMatch } from '../HighlightMatch';

/** Two-line table identity: a bounded title and one compact metadata line. */
export function SettingsIdentity({
  name,
  query,
  icon,
  description,
  metadata,
}: {
  name: string;
  query: string;
  icon?: ReactNode;
  description?: ReactNode;
  metadata?: ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <Flex vertical gap={token.marginXXS} style={{ minWidth: 0 }} data-settings-identity>
      <Flex align="center" gap={token.marginXXS} style={{ minWidth: 0 }}>
        {icon && <span style={{ flexShrink: 0 }}>{icon}</span>}
        <Typography.Text
          strong
          ellipsis={{ tooltip: name }}
          style={{ flex: '0 1 auto', minWidth: 0 }}
        >
          <HighlightMatch text={name} query={query} />
        </Typography.Text>
        {description && (
          <Popover
            trigger="click"
            content={
              <div style={{ maxWidth: 'min(480px, 75vw)', maxHeight: 400, overflow: 'auto' }}>
                {description}
              </div>
            }
          >
            <Button
              type="text"
              size="small"
              icon={<InfoCircleOutlined />}
              aria-label={`Description for ${name}`}
              style={{ flexShrink: 0 }}
              onClick={(event) => event.stopPropagation()}
            />
          </Popover>
        )}
      </Flex>
      {metadata && <div style={{ minWidth: 0, whiteSpace: 'nowrap' }}>{metadata}</div>}
    </Flex>
  );
}
