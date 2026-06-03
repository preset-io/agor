import {
  CheckOutlined,
  InfoCircleOutlined,
  SearchOutlined,
  SortAscendingOutlined,
  SortDescendingOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Input, Tooltip, theme } from 'antd';
import type React from 'react';
import { SESSION_SORT_OPTIONS, type SessionSort } from '../../utils/sessionSearch';

const relevanceTooltip =
  'Matched by title, description, and agent. Active and recently updated sessions rank higher within matches.';

interface SessionSortButtonProps {
  sort: SessionSort;
  onSortChange: (sort: SessionSort) => void;
  compact?: boolean;
  stopPropagation?: boolean;
}

export const SessionSortButton: React.FC<SessionSortButtonProps> = ({
  sort,
  onSortChange,
  compact = false,
  stopPropagation = false,
}) => {
  const { token } = theme.useToken();

  return (
    <Dropdown
      menu={{
        items: SESSION_SORT_OPTIONS.map((option) => ({
          key: option.value,
          label: option.label,
          icon:
            sort === option.value ? (
              <CheckOutlined />
            ) : (
              <span style={{ width: 12, display: 'inline-block' }} />
            ),
        })),
        onClick: ({ key }) => onSortChange(key as SessionSort),
        selectedKeys: [sort],
      }}
      trigger={['click']}
    >
      <Button
        type="text"
        size="small"
        icon={sort === 'oldest' ? <SortAscendingOutlined /> : <SortDescendingOutlined />}
        style={{
          flexShrink: 0,
          padding: '0 6px',
          color: token.colorTextSecondary,
          background: sort !== 'recent' ? token.colorFillSecondary : undefined,
          borderRadius: token.borderRadiusSM,
        }}
        onClick={(event) => {
          if (stopPropagation) event.stopPropagation();
        }}
      >
        {compact ? getCompactSortLabel(sort) : getSortLabel(sort)}
      </Button>
    </Dropdown>
  );
};

interface SessionSearchToolbarProps {
  value: string;
  onChange: (value: string) => void;
  sort: SessionSort;
  onSortChange: (sort: SessionSort) => void;
  searching?: boolean;
  placeholder?: string;
}

export const SessionSearchToolbar: React.FC<SessionSearchToolbarProps> = ({
  value,
  onChange,
  sort,
  onSortChange,
  searching = false,
  placeholder = 'Search sessions...',
}) => {
  const { token } = theme.useToken();

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <Input
        style={{ flex: 1 }}
        placeholder={placeholder}
        prefix={<SearchOutlined />}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        allowClear
      />
      <div style={{ flexShrink: 0, minWidth: 96, display: 'flex', justifyContent: 'flex-end' }}>
        {searching ? (
          <Tooltip title={relevanceTooltip} placement="topRight">
            <Button
              type="text"
              size="small"
              icon={<InfoCircleOutlined style={{ color: token.colorTextTertiary }} />}
              style={{ padding: '0 6px', color: token.colorTextTertiary }}
            >
              Relevance
            </Button>
          </Tooltip>
        ) : (
          <SessionSortButton sort={sort} onSortChange={onSortChange} compact />
        )}
      </div>
    </div>
  );
};

export const SessionRelevanceLabel: React.FC = () => {
  const { token } = theme.useToken();

  return (
    <Tooltip title={relevanceTooltip}>
      <span style={{ borderBottom: `1px dashed ${token.colorTextTertiary}`, cursor: 'help' }}>
        by relevance
      </span>
    </Tooltip>
  );
};

function getCompactSortLabel(sort: SessionSort): string {
  if (sort === 'alpha') return 'A–Z';
  if (sort === 'oldest') return 'Oldest';
  return 'Recent';
}

function getSortLabel(sort: SessionSort): string {
  if (sort === 'alpha') return 'A–Z';
  if (sort === 'oldest') return 'Oldest first';
  return 'Most recent';
}
