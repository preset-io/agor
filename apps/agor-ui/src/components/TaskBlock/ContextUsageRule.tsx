import type { ContextUsageSnapshot } from '@agor/core/types';
import { theme } from 'antd';
import type { ReactNode } from 'react';
import { getContextWindowGradient } from '../../utils/contextWindow';

/** A stable turn wrapper with an always-readable, horizontally scrollable metadata footer. */
export function ContextUsageRule({
  used,
  limit,
  snapshot,
  metadata,
  usageLabel,
  children,
}: {
  used: number | undefined;
  limit: number | undefined;
  snapshot: ContextUsageSnapshot | null | undefined;
  metadata?: ReactNode;
  /** The turn's usage percentage, as whatever opens its breakdown. */
  usageLabel: ReactNode;
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  const gradient = getContextWindowGradient(used, limit, snapshot, {
    normal: token.colorSuccessBorder,
    warning: token.colorWarningBorder,
    critical: token.colorErrorBorder,
  });
  // The wrapper is unconditional so usage arriving mid-stream never remounts the answer.
  return (
    <section aria-label="Turn and its metadata">
      {children}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: token.marginXS,
          minWidth: 0,
        }}
      >
        {metadata && (
          <section
            aria-label="Turn metadata"
            style={{
              minWidth: 0,
              flex: '0 1 auto',
              maxWidth: '100%',
              display: 'flex',
              alignItems: 'center',
              whiteSpace: 'nowrap',
              overflowX: 'auto',
              overflowY: 'hidden',
              overscrollBehaviorX: 'contain',
              scrollbarWidth: 'none',
            }}
          >
            {metadata}
          </section>
        )}
        {gradient && (
          <div
            data-testid="context-usage-rule"
            aria-hidden="true"
            style={{
              flex: '1 1 0',
              minWidth: token.sizeUnit * 2,
              height: token.lineWidth * 2,
              borderRadius: token.lineWidth,
              background: gradient,
              opacity: 0.6,
            }}
          />
        )}
        {usageLabel && (
          <span
            data-testid="turn-usage-label"
            style={{
              flexShrink: 0,
              fontSize: token.fontSizeSM,
              lineHeight: 1,
              color: token.colorTextSecondary,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {usageLabel}
          </span>
        )}
      </div>
    </section>
  );
}
