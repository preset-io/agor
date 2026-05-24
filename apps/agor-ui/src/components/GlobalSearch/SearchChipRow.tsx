import { Segmented, Switch, Tag, Tooltip, theme } from 'antd';
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
 *   [All] [Session] [Branch] [Assistant] [Artifact] [Board] [MCP]
 *   [Created by me]                                       [BETA]
 * Per design doc §3.5. Single-select on type (Segmented — keyboard-nav + ARIA
 * built-in), toggle on scope (Switch).
 */
export const SearchChipRow: React.FC<SearchChipRowProps> = ({
  activeChip,
  onChipChange,
  ownedByMe,
  onOwnedByMeToggle,
}) => {
  const { token } = theme.useToken();

  return (
    <div style={{ padding: '6px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <Segmented
        size="small"
        value={activeChip}
        onChange={(value) => onChipChange(value as ChipFilter)}
        options={TYPE_CHIP_ORDER.map((chip) => ({
          label: TYPE_CHIP_LABELS[chip],
          value: chip,
        }))}
        style={{ marginBottom: 4, fontSize: 12 }}
        aria-label="Filter by entity type"
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <label
          htmlFor="global-search-created-by-me"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <Switch
            id="global-search-created-by-me"
            size="small"
            checked={ownedByMe}
            onChange={onOwnedByMeToggle}
            aria-label="Created by me"
          />
          Created by me
        </label>
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
