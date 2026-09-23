import type { ContextUsageSnapshot } from '@agor/core/types';
import { Tooltip, theme } from 'antd';
import { type ReactNode, useState } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import {
  formatContextWindowSummary,
  getContextWindowGradient,
  resolveContextWindowPercentage,
} from '../../utils/contextWindow';

// Border tokens still read loud at rest in dark; the next token down vanishes in light.
const LINE_RESTING_OPACITY = 0.6;

/**
 * Ambient "how full is the context" cue under a turn's answer: a hairline
 * filled and colored by the same helpers `ContextWindowPill` reads, with the
 * percentage beside it as a small number.
 *
 * Muted enough to be noticed only when looked for. Turns with no usage data —
 * anything the executor hasn't reported a snapshot for — render their answer
 * with nothing added.
 */
export function ContextUsageRule({
  used,
  limit,
  snapshot,
  children,
}: {
  used: number | undefined;
  limit: number | undefined;
  snapshot: ContextUsageSnapshot | null | undefined;
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  const reducedMotion = usePrefersReducedMotion();
  const [hovered, setHovered] = useState(false);

  // Same bands as the pill (<50 / <80 / rest), in the border tokens: a fill
  // tint is invisible at this height and the solid colors shout.
  const gradient = getContextWindowGradient(used, limit, snapshot, {
    normal: token.colorSuccessBorder,
    warning: token.colorWarningBorder,
    critical: token.colorErrorBorder,
  });
  const percentage = Math.round(resolveContextWindowPercentage(used, limit, snapshot));

  // The wrapper is unconditional even though the rule is not. Usage data lands
  // when the turn completes, so swapping this element for a fragment on the
  // way there would remount the whole answer mid-stream.
  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {children}
      {/* The tooltip covers the line and its label together: the percentage is
          the summary, and the absolute counts behind it are what a reader
          hovering actually wants. No role or ARIA state here — a native
          <meter> can't carry the band gradient without pseudo-element CSS, and
          ARIA state is not supported on a generic div, so the visible number
          stays the accessible content. */}
      {gradient && (
        <Tooltip title={formatContextWindowSummary(used, limit, snapshot)} placement="top">
          <div
            data-testid="context-usage-rule"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: token.marginXS,
              marginTop: token.marginXXS,
            }}
          >
            {/* The gradient stops at the usage percentage, so the line reads as a
            fill as well as a band color. */}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                height: token.lineWidth * 2,
                borderRadius: token.lineWidth,
                background: gradient,
                opacity: hovered ? 1 : LINE_RESTING_OPACITY,
                transition: reducedMotion
                  ? 'none'
                  : `opacity ${token.motionDurationFast} ${token.motionEaseOut}`,
              }}
            />
            <span
              style={{
                flexShrink: 0,
                fontSize: token.fontSizeSM,
                lineHeight: 1,
                color: token.colorTextTertiary,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {percentage}%
            </span>
          </div>
        </Tooltip>
      )}
    </div>
  );
}
