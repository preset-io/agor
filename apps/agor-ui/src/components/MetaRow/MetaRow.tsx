import type { CSSProperties, ReactNode } from 'react';

export interface MetaRowProps {
  avatar?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  style?: CSSProperties;
}

/**
 * Lightweight replacement for AntD's deprecated <List.Item.Meta>.
 * Flex row with optional avatar on the left and stacked title/description on the right.
 */
export const MetaRow: React.FC<MetaRowProps> = ({ avatar, title, description, style }) => {
  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        alignItems: 'flex-start',
        maxWidth: '100%',
        ...style,
      }}
    >
      {avatar !== undefined && avatar !== null && (
        <div style={{ marginInlineEnd: 16, flexShrink: 0 }}>{avatar}</div>
      )}
      <div style={{ flex: '1 0', minWidth: 0 }}>
        {title !== undefined && title !== null && <div style={{ marginBottom: 4 }}>{title}</div>}
        {description !== undefined && description !== null && <div>{description}</div>}
      </div>
    </div>
  );
};

export default MetaRow;
