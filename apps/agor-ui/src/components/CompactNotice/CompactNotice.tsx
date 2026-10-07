import {
  CloseCircleOutlined,
  CloseOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  MinusCircleOutlined,
  UpOutlined,
} from '@ant-design/icons';
import {
  Button,
  ConfigProvider,
  Flex,
  type FlexProps,
  type ThemeConfig,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { Fragment, useId, useMemo, useRef, useState } from 'react';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { VISUALLY_HIDDEN_STYLE } from '../../utils/accessibility';
import { useCopyToClipboard } from '../../utils/clipboard';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { type CompactNoticeType, noticeColors } from './noticeColors';

export type { CompactNoticeType };

export interface CompactNoticeAction {
  label: string;
  onClick: () => void;
  loading?: boolean;
}

export interface CompactNoticeDetail {
  label: string;
  /** Shown and copied verbatim; wraps, never truncated. */
  value: string;
  /** Monospace, for codes, IDs and raw errors. */
  code?: boolean;
}

export interface CompactNoticeProps extends Omit<FlexProps, 'children' | 'title'> {
  type: CompactNoticeType;
  message: React.ReactNode;
  /** At most two; extras are ignored. */
  actions?: CompactNoticeAction[];
  /** Technical facts revealed inline under a "Details" toggle; copied as `Label: value` lines. */
  details?: CompactNoticeDetail[];
  /** Plain-language context shown above the technical facts. */
  detailsLead?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}

const ICONS = {
  error: CloseCircleOutlined,
  warning: ExclamationCircleOutlined,
  info: InfoCircleOutlined,
  neutral: MinusCircleOutlined,
} as const;

const SEVERITY_LABELS = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
  neutral: 'Note',
} as const;

/** Shortest message width, in ems, before the actions wrap below it. */
const MESSAGE_MIN_WIDTH_EM = 12;

type HitDirection = 'center' | 'above' | 'below';

/**
 * Invisible touch target around a compact bordered control; the button is
 * already positioned. It grows away from neighbouring text it must not cover.
 */
function TouchHitArea({
  height,
  width,
  border,
  direction,
}: {
  height: number;
  width?: number;
  border: number;
  direction: HitDirection;
}) {
  const grow = MOBILE_TOUCH_TARGET - height;
  const before = { center: grow / 2, above: grow, below: 0 }[direction];
  return (
    <span
      aria-hidden
      data-touch-hit-area
      style={{
        position: 'absolute',
        insetBlockStart: -before - border,
        insetBlockEnd: -(grow - before) - border,
        insetInline: width ? -(MOBILE_TOUCH_TARGET - width) / 2 - border : 0,
      }}
    />
  );
}

/** One-line, token-styled notice on a 20px row grid; on phones the actions take their own row. */
export function CompactNotice({
  type,
  message,
  actions,
  details,
  detailsLead,
  onDismiss,
  dismissLabel = 'Dismiss',
  style,
  ...rest
}: CompactNoticeProps) {
  const { token } = theme.useToken();
  const isMobile = useIsMobileViewport();
  const reducedMotion = usePrefersReducedMotion();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, copy] = useCopyToClipboard();
  const [copyFailed, setCopyFailed] = useState(false);
  const detailsId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const colors = useMemo(() => noticeColors(token, type), [token, type]);
  // Button focus rings are :focus-visible only; scope them to the notice's legible text colour.
  const focusTheme = useMemo<ThemeConfig>(
    () => ({ token: { colorPrimaryBorder: colors.text, lineWidthFocus: 2 } }),
    [colors.text]
  );
  const Icon = ICONS[type];
  const row = token.sizeMD;
  const control: React.CSSProperties = {
    fontSize: token.fontSizeSM,
    paddingInline: token.sizeXXS,
    height: row,
    color: colors.text,
    ...(reducedMotion ? { transition: 'none' } : {}),
  };
  const hitArea = (direction: HitDirection, width?: number) =>
    isMobile && (
      <TouchHitArea height={row} width={width} border={token.lineWidth} direction={direction} />
    );
  const rowHit: HitDirection = detailsOpen ? 'above' : 'center';
  const flushEnd = (isLast: boolean) =>
    isLast && !onDismiss ? { marginInlineEnd: -(token.sizeXXS + token.lineWidth) } : undefined;
  const visibleActions = actions?.slice(0, 2) ?? [];
  const hasDetails = !!details?.length || !!detailsLead;

  const copyDetails = async () => {
    const text = [detailsLead, ...(details ?? []).map(({ label, value }) => `${label}: ${value}`)]
      .filter(Boolean)
      .join('\n');
    if (!text) return;
    setCopyFailed(!(await copy(text)));
  };
  const collapseOnEscape = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setDetailsOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <ConfigProvider theme={focusTheme}>
      <Flex
        vertical
        data-notice-type={type}
        {...rest}
        style={{
          paddingBlock: token.sizeXXS,
          paddingInline: token.sizeSM,
          background: colors.background,
          borderWidth: token.lineWidth,
          borderStyle: 'solid',
          borderColor: colors.border,
          borderRadius: token.borderRadiusSM,
          ...style,
        }}
      >
        <Flex align="flex-start" gap={token.sizeXS}>
          <Flex align="center" style={{ height: row, flexShrink: 0 }}>
            <Icon
              role="img"
              aria-label={SEVERITY_LABELS[type]}
              style={{ fontSize: token.fontSizeIcon, color: colors.text }}
            />
          </Flex>
          <Flex
            wrap
            align="flex-start"
            style={{ flex: 1, minWidth: 0, columnGap: token.sizeXS, rowGap: 0 }}
          >
            <Typography.Text
              style={{
                color: colors.text,
                fontSize: token.fontSizeSM,
                lineHeight: `${row}px`,
                flex: isMobile ? '1 1 100%' : `1 1 ${MESSAGE_MIN_WIDTH_EM}em`,
                minWidth: 0,
                overflowWrap: 'anywhere',
              }}
            >
              {message}
            </Typography.Text>
            {(hasDetails || visibleActions.length > 0) && (
              <Flex
                align="center"
                gap={token.sizeXS}
                style={{ flexShrink: 0, marginInlineStart: 'auto' }}
              >
                {hasDetails && (
                  <Button
                    ref={toggleRef}
                    type="text"
                    size="small"
                    aria-expanded={detailsOpen}
                    aria-controls={detailsOpen ? detailsId : undefined}
                    onClick={() => setDetailsOpen((open) => !open)}
                    icon={
                      detailsOpen ? (
                        <UpOutlined aria-hidden style={{ fontSize: '0.75em' }} />
                      ) : (
                        <DownOutlined aria-hidden style={{ fontSize: '0.75em' }} />
                      )
                    }
                    iconPlacement="end"
                    style={{ ...control, ...flushEnd(visibleActions.length === 0) }}
                  >
                    Details
                    {hitArea(rowHit)}
                  </Button>
                )}
                {visibleActions.map((action, index) => (
                  <Button
                    key={action.label}
                    type="text"
                    size="small"
                    loading={action.loading}
                    onClick={action.onClick}
                    style={{
                      ...control,
                      fontWeight: token.fontWeightStrong,
                      ...flushEnd(index === visibleActions.length - 1),
                    }}
                  >
                    {action.label}
                    {hitArea(rowHit)}
                  </Button>
                ))}
              </Flex>
            )}
          </Flex>
          {onDismiss && (
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined style={{ fontSize: token.fontSizeIcon }} />}
              aria-label={dismissLabel}
              onClick={onDismiss}
              style={{
                ...control,
                flexShrink: 0,
                width: row,
                minWidth: row,
                paddingInline: 0,
                marginInlineStart: token.sizeXS,
              }}
            >
              {hitArea('center', row)}
            </Button>
          )}
        </Flex>
        {hasDetails && detailsOpen && (
          <Flex
            id={detailsId}
            role="region"
            aria-label="Technical details"
            vertical
            align="flex-start"
            onKeyDown={collapseOnEscape}
            style={{ paddingInlineStart: token.fontSizeIcon + token.sizeXS }}
          >
            {detailsLead && (
              <Typography.Text style={{ fontSize: token.fontSizeSM, lineHeight: `${row}px` }}>
                {detailsLead}
              </Typography.Text>
            )}
            {!!details?.length && (
              <dl
                style={{
                  alignSelf: 'stretch',
                  display: 'grid',
                  gridTemplateColumns: 'max-content minmax(0, 1fr)',
                  columnGap: token.sizeSM,
                  margin: 0,
                }}
              >
                {details.map(({ label, value, code }) => (
                  <Fragment key={label}>
                    <dt style={{ margin: 0 }}>
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: token.fontSizeSM, lineHeight: `${row}px` }}
                      >
                        {label}
                      </Typography.Text>
                    </dt>
                    <dd style={{ margin: 0, minWidth: 0 }}>
                      <Typography.Text
                        style={{
                          fontFamily: code ? token.fontFamilyCode : undefined,
                          fontSize: token.fontSizeSM,
                          lineHeight: `${row}px`,
                          whiteSpace: 'pre-wrap',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {value}
                      </Typography.Text>
                    </dd>
                  </Fragment>
                ))}
              </dl>
            )}
            <Button
              type="text"
              size="small"
              onClick={copyDetails}
              style={{ ...control, marginInlineStart: -(token.sizeXXS + token.lineWidth) }}
            >
              {copyFailed ? "Couldn't copy" : copied ? 'Copied' : 'Copy details'}
              {hitArea('below')}
            </Button>
          </Flex>
        )}
        <span aria-live="polite" style={VISUALLY_HIDDEN_STYLE}>
          {copyFailed ? "Couldn't copy" : copied ? 'Copied to clipboard' : ''}
        </span>
      </Flex>
    </ConfigProvider>
  );
}
