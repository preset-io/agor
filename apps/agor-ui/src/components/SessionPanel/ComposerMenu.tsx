import {
  CheckOutlined,
  DownOutlined,
  LeftOutlined,
  PushpinFilled,
  PushpinOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { Button, Drawer, Flex, Popover, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';

const MENU_WIDTH = 300;

const ComposerMenuDensity = React.createContext<{ sheet: boolean }>({ sheet: false });

const useRowHeight = () => {
  const { token } = theme.useToken();
  const { sheet } = React.useContext(ComposerMenuDensity);
  return sheet ? MOBILE_TOUCH_TARGET : token.controlHeightLG - token.sizeXXS;
};

interface ComposerMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sheet title and the dialog's accessible name. */
  title: string;
  /** Bottom sheet on phones; otherwise a popover anchored to the trigger, opening upward. */
  sheet: boolean;
  content: React.ReactNode;
  children: React.ReactElement;
  /** The popover sits above this element (the composer card) instead of over it. */
  above?: React.RefObject<HTMLElement | null>;
  /** Selector inside the menu to scroll to and focus on open, such as one row. */
  focusTarget?: string;
}

/** One composer menu: a popover on desktop, a bottom sheet on phones. Never nested. */
export function ComposerMenu({
  open,
  onOpenChange,
  title,
  sheet,
  content,
  children,
  above,
  focusTarget,
}: ComposerMenuProps) {
  const { token } = theme.useToken();
  const reducedMotion = usePrefersReducedMotion();
  const anchorRef = React.useRef<HTMLSpanElement>(null);
  // Distance from the trigger's top up to the card's top, so the popover clears the card.
  const [lift, setLift] = React.useState(0);
  // Room between the popover's bottom and the top of the panel, below the app header.
  const [maxHeight, setMaxHeight] = React.useState<number | undefined>(undefined);
  const measureLift = React.useCallback(() => {
    const trigger = anchorRef.current?.getBoundingClientRect();
    const card = above?.current?.getBoundingClientRect();
    setLift(trigger && card ? Math.max(0, trigger.top - card.top) : 0);
    const bottom = (card ?? trigger)?.top;
    if (bottom === undefined) return;
    const bounds = anchorRef.current?.closest('[data-composer-bounds]')?.getBoundingClientRect();
    const room =
      bottom - token.sizeXS - (bounds?.top ?? 0) - token.paddingXS - token.paddingXXS * 2;
    setMaxHeight(room > 0 ? room : undefined);
  }, [above, token.sizeXS, token.paddingXS, token.paddingXXS]);
  React.useLayoutEffect(() => {
    if (open && !sheet) measureLift();
  }, [open, sheet, measureLift]);

  const close = () => {
    onOpenChange(false);
    anchorRef.current?.querySelector<HTMLElement>('button')?.focus();
  };

  const contentRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const root = contentRef.current;
      const target = focusTarget ? root?.querySelector<HTMLElement>(focusTarget) : null;
      if (target) {
        target.scrollIntoView?.({ block: 'nearest' });
        target.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
      } else if (!sheet) {
        root?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, sheet, focusTarget]);

  const body = (
    <ComposerMenuDensity.Provider value={{ sheet }}>
      <div ref={contentRef}>{content}</div>
    </ComposerMenuDensity.Provider>
  );

  if (sheet) {
    return (
      <>
        {children}
        <Drawer
          open={open}
          onClose={() => onOpenChange(false)}
          placement="bottom"
          height="auto"
          title={title}
          destroyOnHidden
          {...reducedMotionSurface(reducedMotion)}
          styles={{
            wrapper: { maxHeight: '88dvh' },
            section: { maxHeight: '88dvh' },
            content: glassSurfaceStyle(token, 0.88),
            body: {
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehaviorY: 'contain',
              padding: `${token.paddingXXS}px 0`,
              paddingBottom: `calc(${token.paddingXS}px + env(safe-area-inset-bottom))`,
            },
          }}
        >
          {body}
        </Drawer>
      </>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger="click"
      placement="topLeft"
      align={{ offset: [0, -(token.sizeXS + lift)] }}
      arrow={false}
      destroyOnHidden
      styles={{
        container: { ...glassSurfaceStyle(token, 0.95), padding: token.paddingXXS },
      }}
      content={
        <div
          role="dialog"
          aria-label={title}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
          style={{
            width: MENU_WIDTH,
            maxWidth: `calc(100vw - ${token.paddingLG}px)`,
            maxHeight,
            overflowY: 'auto',
            overscrollBehaviorY: 'contain',
          }}
        >
          {body}
        </div>
      }
    >
      {/* Esc also closes while focus is still on the trigger, before it moves into the menu. */}
      <span
        ref={anchorRef}
        style={{ display: 'inline-flex', minWidth: 0 }}
        onKeyDown={(event) => {
          if (!open || event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        {children}
      </span>
    </Popover>
  );
}

export function ComposerMenuSection({ children }: { children: React.ReactNode }) {
  const { token } = theme.useToken();
  return (
    <Typography.Text
      type="secondary"
      style={{
        display: 'block',
        fontSize: token.fontSizeSM,
        padding: `${token.paddingXS}px ${token.paddingSM}px ${token.paddingXXS}px`,
      }}
    >
      {children}
    </Typography.Text>
  );
}

export function ComposerMenuNote({ children }: { children: React.ReactNode }) {
  const { token } = theme.useToken();
  return (
    <Typography.Text
      type="secondary"
      style={{
        display: 'block',
        fontSize: token.fontSizeSM,
        padding: `${token.paddingXXS}px ${token.paddingSM}px`,
      }}
    >
      {children}
    </Typography.Text>
  );
}

interface ComposerMenuRowProps {
  label: string;
  icon?: React.ReactNode;
  hint?: string;
  /** Current value, shown at the end of the row. */
  value?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Radio rows show a check instead of colour alone. */
  checked?: boolean;
  /** Drill-in rows end in a chevron. */
  drill?: boolean;
  /** Rows that expand inline end in a down chevron that turns up when open. */
  expanded?: boolean;
  ariaLabel?: string;
  /** A sibling control, such as a pin toggle. */
  trailing?: React.ReactNode;
  testId?: string;
}

export function ComposerMenuRow({
  label,
  icon,
  hint,
  value,
  onClick,
  disabled,
  checked,
  drill,
  expanded,
  ariaLabel,
  trailing,
  testId,
}: ComposerMenuRowProps) {
  const { token } = theme.useToken();
  const rowHeight = useRowHeight();
  const body = (
    <Flex align="center" gap={token.marginXS} style={{ flex: 1, minWidth: 0 }}>
      <Flex vertical style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text ellipsis style={{ color: 'inherit' }}>
          {label}
        </Typography.Text>
        {hint && (
          <Typography.Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
            {hint}
          </Typography.Text>
        )}
      </Flex>
      {value !== undefined && (
        <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
          {value}
        </Typography.Text>
      )}
      {checked && <CheckOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />}
      {drill && <RightOutlined style={{ color: token.colorTextTertiary, flexShrink: 0 }} />}
      {expanded !== undefined && (
        <DownOutlined
          rotate={expanded ? 180 : 0}
          style={{ color: token.colorTextTertiary, flexShrink: 0 }}
        />
      )}
    </Flex>
  );
  return (
    <Flex align="center" style={{ minHeight: rowHeight, paddingInline: token.paddingXXS }}>
      {onClick ? (
        <Button
          type="text"
          block
          role={checked === undefined ? undefined : 'radio'}
          aria-checked={checked}
          aria-expanded={expanded}
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={onClick}
          icon={icon}
          data-testid={testId}
          style={{
            flex: 1,
            minWidth: 0,
            height: 'auto',
            minHeight: rowHeight,
            justifyContent: 'flex-start',
            textAlign: 'start',
            paddingInline: token.paddingXS,
          }}
        >
          {body}
        </Button>
      ) : (
        <Flex
          align="center"
          gap={token.marginXS}
          data-testid={testId}
          style={{ flex: 1, minWidth: 0, minHeight: rowHeight, paddingInline: token.paddingXS }}
        >
          {icon && (
            <span style={{ color: token.colorTextSecondary, display: 'inline-flex' }}>{icon}</span>
          )}
          {body}
        </Flex>
      )}
      {trailing}
    </Flex>
  );
}

export function ComposerMenuBack({ label, onBack }: { label: string; onBack: () => void }) {
  const { token } = theme.useToken();
  const rowHeight = useRowHeight();
  return (
    <Flex align="center" gap={token.marginXXS} style={{ minHeight: rowHeight }}>
      <Button
        type="text"
        aria-label={`Back to ${label.toLowerCase()}`}
        icon={<LeftOutlined />}
        onClick={onBack}
        style={{ minWidth: rowHeight, height: rowHeight }}
      />
      <Typography.Text strong>{label}</Typography.Text>
    </Flex>
  );
}

interface ComposerPinToggleProps {
  pinned: boolean;
  /** Accessible name, such as "Pin Fork session to the composer". */
  label: string;
  tooltip: string;
  onToggle: () => void;
  disabled?: boolean;
}

export function ComposerPinToggle({
  pinned,
  label,
  tooltip,
  onToggle,
  disabled,
}: ComposerPinToggleProps) {
  const { token } = theme.useToken();
  const rowHeight = useRowHeight();
  return (
    <Tooltip title={tooltip} placement="right">
      <Button
        type="text"
        aria-label={label}
        aria-pressed={pinned}
        disabled={disabled}
        icon={pinned ? <PushpinFilled /> : <PushpinOutlined />}
        onClick={onToggle}
        style={{
          minWidth: rowHeight,
          height: rowHeight,
          flexShrink: 0,
          color: pinned ? token.colorPrimary : token.colorTextTertiary,
        }}
      />
    </Tooltip>
  );
}
