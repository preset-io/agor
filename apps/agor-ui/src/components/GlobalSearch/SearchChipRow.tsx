import { Segmented, Switch, Tag, Tooltip, theme } from 'antd';
import type React from 'react';
import { type ChipFilter, type SearchCounts, TYPE_CHIP_LABELS, TYPE_CHIP_ORDER } from './types';
import { sumCounts } from './utils';

interface SearchChipRowProps {
  activeChip: ChipFilter;
  onChipChange: (chip: ChipFilter) => void;
  ownedByMe: boolean;
  onOwnedByMeToggle: () => void;
  /** Per-type match totals. `undefined` (or all-zero) hides badges — used to
   * suppress count tags when there's no live query (recents view). */
  counts?: SearchCounts;
}

/**
 * Two-row chip surface above search results:
 *   [All] [Session] [Branch] [Teammate] [Artifact] [Board] [MCP]
 *   [Created by me]                                       [BETA]
 * Per design doc §3.5. Single-select on type (Segmented — keyboard-nav + ARIA
 * built-in), toggle on scope (Switch).
 */
export const SearchChipRow: React.FC<SearchChipRowProps> = ({
  activeChip,
  onChipChange,
  ownedByMe,
  onOwnedByMeToggle,
  counts,
}) => {
  const { token } = theme.useToken();

  const totalCount = counts ? sumCounts(counts) : 0;
  const showCounts = !!counts && totalCount > 0;

  return (
    <div style={{ padding: '6px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <Segmented
        size="small"
        value={activeChip}
        onChange={(value) => onChipChange(value as ChipFilter)}
        options={TYPE_CHIP_ORDER.map((chip) => ({
          label: (
            <ChipLabel
              label={TYPE_CHIP_LABELS[chip]}
              count={showCounts ? (chip === 'all' ? totalCount : (counts?.[chip] ?? 0)) : undefined}
              isActive={activeChip === chip}
              token={token}
            />
          ),
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

/**
 * Chip label with optional count badge. The badge sits to the right of the
 * label and uses a muted, borderless tag so it reads as supplementary rather
 * than competing with the label. The count for the active chip is rendered
 * with the active token color so it stays legible against Segmented's
 * highlight background.
 */
const ChipLabel: React.FC<{
  label: string;
  count: number | undefined;
  isActive: boolean;
  token: ReturnType<typeof theme.useToken>['token'];
}> = ({ label, count, isActive, token }) => {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label}
      {count !== undefined && (
        <Tag
          style={{
            margin: 0,
            padding: '0 5px',
            fontSize: 10,
            lineHeight: '14px',
            border: 'none',
            background: isActive ? token.colorFillSecondary : token.colorFillTertiary,
            color: token.colorTextSecondary,
          }}
        >
          {count}
        </Tag>
      )}
    </span>
  );
};
