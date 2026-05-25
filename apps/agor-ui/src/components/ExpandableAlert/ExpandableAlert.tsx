/**
 * Compact AntD Alert with an inline "See details" toggle.
 *
 * Use when an Alert's body is long-form reference material (variable
 * tables, syntax help, etc.) that users mostly skim once. Keeps the
 * title at normal text size — AntD's stock Alert title scales up when
 * `description` is also set, which makes reference boxes feel heavier
 * than they should.
 *
 * Do NOT use for destructive warnings or actionable instructions that
 * must remain visible (e.g. security notices, "Server not running" with
 * a command users need to copy).
 */
import { DownOutlined } from '@ant-design/icons';
import { Alert, type AlertProps, Button, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';

export interface ExpandableAlertProps {
  /** Short label shown next to the alert icon. Rendered at normal text size. */
  title: ReactNode;
  /** Optional one-line summary shown next to the title, before the toggle. */
  summary?: ReactNode;
  /** Detailed content revealed when expanded. */
  children: ReactNode;
  /** Visual variant. Defaults to `info`. */
  type?: AlertProps['type'];
  /** Whether the details start expanded. Defaults to `false`. */
  defaultExpanded?: boolean;
  expandLabel?: string;
  collapseLabel?: string;
  style?: AlertProps['style'];
  className?: AlertProps['className'];
}

export const ExpandableAlert = ({
  title,
  summary,
  children,
  type = 'info',
  defaultExpanded = false,
  expandLabel = 'See details',
  collapseLabel = 'Hide details',
  style,
  className,
}: ExpandableAlertProps) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { token } = theme.useToken();
  const detailsId = useId();

  const toggle = () => setExpanded((prev) => !prev);

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        columnGap: token.marginXS,
        rowGap: token.marginXXS,
      }}
    >
      <Typography.Text strong>{title}</Typography.Text>
      {summary && (
        <Typography.Text type="secondary" style={{ fontWeight: 'normal' }}>
          {summary}
        </Typography.Text>
      )}
      <Button
        type="link"
        size="small"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={detailsId}
        style={{ paddingInline: 0, height: 'auto' }}
      >
        {expanded ? collapseLabel : expandLabel}{' '}
        <DownOutlined aria-hidden style={{ fontSize: 10 }} rotate={expanded ? 180 : 0} />
      </Button>
    </div>
  );

  return (
    <Alert
      type={type}
      showIcon
      style={style}
      className={className}
      // Tame the slot's default font-size — AntD bumps the title up when a
      // description is also present, but our header is just normal text with
      // a Typography.Text strong wrapper for the title itself.
      styles={{ title: { fontSize: token.fontSize } }}
      title={header}
      description={expanded ? <div id={detailsId}>{children}</div> : undefined}
    />
  );
};
