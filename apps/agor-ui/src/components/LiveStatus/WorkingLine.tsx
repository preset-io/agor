import { Badge, Flex, theme } from 'antd';
import { formatDuration } from '../Pill/TimerPill';
import { LiveLabel, useTickingNow } from './LiveLabel';

/**
 * The turn's one live status line: what the agent is doing now, plus elapsed time.
 * Waiting on the reader is static, with a warning dot and no timer.
 */
export function WorkingLine({
  step,
  startedAt,
  waiting = false,
}: {
  step: string;
  startedAt?: string | number;
  waiting?: boolean;
}) {
  const { token } = theme.useToken();
  const now = useTickingNow(!waiting);
  const start = startedAt === undefined ? Number.NaN : new Date(startedAt).getTime();
  const elapsed = Number.isFinite(start) ? now - start : undefined;
  return (
    <Flex
      align="center"
      gap={token.marginXS}
      style={{
        margin: `${token.marginSM}px 0`,
        fontSize: token.fontSizeSM,
        color: token.colorTextSecondary,
        minWidth: 0,
      }}
    >
      {waiting && <Badge status="warning" />}
      {/* Announces step changes; the per-second timer stays outside. */}
      <span role="status" style={{ minWidth: 0, overflow: 'hidden' }}>
        <LiveLabel active={!waiting}>{step}</LiveLabel>
      </span>
      {!waiting && elapsed !== undefined && (
        <span
          aria-hidden="true"
          style={{
            flexShrink: 0,
            color: token.colorTextTertiary,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          · {formatDuration(elapsed)}
        </span>
      )}
    </Flex>
  );
}
