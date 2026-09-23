import { Flex, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

interface HomeRowProps {
  ariaLabel: string;
  onOpen: () => void;
  /** 16px leading column: agent logo, file glyph. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  /** Native tooltip for the title; carries context the one-line row leaves out. */
  tooltip?: string;
  /** Recede one step (secondary text) for rows that need nothing from the user. */
  read?: boolean;
  /** Quiet metadata beside the title, e.g. the branch; the title yields space first. */
  meta?: React.ReactNode;
  /** Always-visible trailing slot (status mark, time). */
  trailing?: React.ReactNode;
  /** Row actions: replace the trailing slot on hover/focus, visually hidden otherwise. */
  hover?: React.ReactNode;
  /** Error tint for rows whose latest work failed. */
  fill?: string;
  /** Extra lines under the row (search snippets). */
  below?: React.ReactNode;
}

/**
 * One-line row in the session panel's grammar: borderless, 32px, fill on hover.
 * Row actions sit beside the open button, never inside it (no nested buttons).
 */
export function HomeRow({
  ariaLabel,
  onOpen,
  leading,
  title,
  tooltip,
  read = false,
  meta,
  trailing,
  hover,
  fill,
  below,
}: HomeRowProps) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const active = hovered || focusWithin;

  return (
    <div
      style={{
        // Contains the visually hidden row actions, so they scroll with the row.
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        borderRadius: token.borderRadiusSM,
        background: fill ?? (active ? token.controlItemBgHover : undefined),
        paddingInlineEnd: token.paddingXS,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusWithin(false);
        }
      }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onOpen}
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          paddingBlock: 0,
          paddingInlineStart: token.paddingXS,
          paddingInlineEnd: token.marginXS,
        }}
      >
        <Flex align="center" gap={token.marginXS} style={{ minHeight: token.controlHeight }}>
          {leading}
          <span
            title={tooltip}
            style={{
              fontSize: 13,
              color: read ? token.colorTextSecondary : token.colorText,
              flex: meta ? '0 1 auto' : 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
          {meta && (
            <span
              style={{
                color: token.colorTextDescription,
                fontSize: token.fontSizeSM,
                flex: '0 1 auto',
                minWidth: 48,
                maxWidth: '35%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {meta}
            </span>
          )}
        </Flex>
        {below}
      </button>
      {(trailing || hover) && (
        <Flex
          align="center"
          gap={token.marginXXS}
          style={{ flex: '0 0 auto', minHeight: token.controlHeight }}
        >
          {!(hover && active) && trailing}
          {/* Always mounted so screen readers and Tab can reach it; shown on hover/focus. */}
          {hover && (
            <Flex align="center" gap={token.marginXXS} style={active ? undefined : VISUALLY_HIDDEN}>
              {hover}
            </Flex>
          )}
        </Flex>
      )}
    </div>
  );
}

/** Muted trailing text (time, counts) sized like the panel's toolbar time. */
export const HomeTime: React.FC<{ children: React.ReactNode; title?: string }> = ({
  children,
  title,
}) => {
  const { token } = theme.useToken();
  return (
    <span
      title={title}
      style={{
        color: token.colorTextTertiary,
        fontSize: 11,
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      }}
    >
      {children}
    </span>
  );
};

/** "26m ago" → "26m", "just now" → "now": a trailing time column needs no suffix. */
export const compactRelativeTime = (relative: string): string =>
  relative === 'just now' ? 'now' : relative.replace(/ ago$/, '');
