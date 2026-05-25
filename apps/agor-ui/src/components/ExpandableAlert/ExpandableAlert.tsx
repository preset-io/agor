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
import { Alert, Button, Typography, theme } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';

export interface ExpandableAlertProps {
  /** Short label shown next to the alert icon. Rendered at normal text size. */
  title: ReactNode;
  /** Optional one-line summary shown next to the title, before the toggle. */
  summary?: ReactNode;
  /** Detailed content revealed when expanded. */
  children: ReactNode;
  /** Visual variant. Defaults to `info`. */
  type?: 'info' | 'success' | 'warning' | 'error';
  /** Whether the details start expanded. Defaults to `false`. */
  defaultExpanded?: boolean;
  expandLabel?: string;
  collapseLabel?: string;
  style?: CSSProperties;
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
}: ExpandableAlertProps) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { token } = theme.useToken();

  const toggle = () => setExpanded((prev) => !prev);

  return (
    <Alert
      type={type}
      showIcon
      style={style}
      title={
        <div>
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
              style={{ paddingInline: 0, height: 'auto' }}
            >
              {expanded ? collapseLabel : expandLabel}{' '}
              <DownOutlined style={{ fontSize: 10 }} rotate={expanded ? 180 : 0} />
            </Button>
          </div>
          {expanded && (
            <div style={{ marginTop: token.marginXS, fontWeight: 'normal' }}>{children}</div>
          )}
        </div>
      }
    />
  );
};
