import { Tag, Tooltip, theme } from 'antd';
import type React from 'react';
import { type ChipFilter, TYPE_CHIP_LABELS, TYPE_CHIP_ORDER } from './types';

interface SearchChipRowProps {
  activeChip: ChipFilter;
  onChipChange: (chip: ChipFilter) => void;
  ownedByMe: boolean;
  onOwnedByMeToggle: () => void;
}

/**
 * Two-row chip surface above search results:
 *   [All] [Session] [Worktree] [Assistant] [Artifact] [Board] [MCP]
 *   [✓ Created by me]
 * Per design doc §3.5. Single-select on type, toggle on scope.
 */
export const SearchChipRow: React.FC<SearchChipRowProps> = ({
  activeChip,
  onChipChange,
  ownedByMe,
  onOwnedByMeToggle,
}) => {
  const { token } = theme.useToken();

  return (
    <div style={{ padding: '8px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {TYPE_CHIP_ORDER.map((chip) => {
          const active = chip === activeChip;
          return (
            <Tag.CheckableTag
              key={chip}
              checked={active}
              onChange={() => onChipChange(chip)}
              style={{
                cursor: 'pointer',
                userSelect: 'none',
                fontSize: 12,
                lineHeight: '20px',
                padding: '1px 8px',
              }}
            >
              {TYPE_CHIP_LABELS[chip]}
            </Tag.CheckableTag>
          );
        })}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Tag.CheckableTag
          checked={ownedByMe}
          onChange={onOwnedByMeToggle}
          style={{
            cursor: 'pointer',
            userSelect: 'none',
            fontSize: 12,
            lineHeight: '20px',
            padding: '1px 8px',
          }}
        >
          {ownedByMe ? '✓ ' : ''}Created by me
        </Tag.CheckableTag>
        <Tooltip
          title="Global search is in beta — some click targets are still stubs (e.g. MCP opens Settings) and message-content search isn't wired up yet. Expect rough edges."
          placement="bottom"
        >
          <Tag
            color="orange"
            style={{
              fontSize: 10,
              lineHeight: '16px',
              padding: '0 6px',
              margin: 0,
              cursor: 'help',
              userSelect: 'none',
            }}
          >
            BETA
          </Tag>
        </Tooltip>
      </div>
    </div>
  );
};
