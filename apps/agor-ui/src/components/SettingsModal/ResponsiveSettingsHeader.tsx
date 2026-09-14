import { Flex, Grid, Typography } from 'antd';
import type { ReactNode } from 'react';

export interface ResponsiveSettingsHeaderProps {
  description: ReactNode;
  actions: (compact: boolean) => ReactNode;
}

/** Shared description/action header for settings tables and management lists. */
export function ResponsiveSettingsHeader({ description, actions }: ResponsiveSettingsHeaderProps) {
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;

  return (
    <Flex
      vertical={compact}
      gap={compact ? 12 : 16}
      align={compact ? 'stretch' : 'center'}
      justify="space-between"
      style={{ width: '100%', minWidth: 0, marginBottom: 16 }}
    >
      <Typography.Text type="secondary" style={{ minWidth: 0 }}>
        {description}
      </Typography.Text>
      <div style={{ width: compact ? '100%' : undefined, minWidth: 0 }}>{actions(compact)}</div>
    </Flex>
  );
}
