/**
 * One-card, one-action full page used by standalone flows that do not start the
 * Workspace (MCP connect/recovery from Slack, `agor login` browser step).
 */

import { Card, Flex, Typography, theme } from 'antd';
import { type ReactNode, useEffect, useRef } from 'react';

export interface ActionPageShellProps {
  titleId: string;
  title: string;
  subtitle: string;
  status: ReactNode;
  /** The page's single primary action, when one is available. */
  primaryAction?: ReactNode;
  /** Optional secondary action beside it (e.g. a return link). */
  secondaryAction?: ReactNode;
  footnote: ReactNode;
}

/**
 * One card, one heading, one status region, one action row.
 *
 * The heading takes focus on mount and the body is `aria-live="polite"`, so a
 * screen-reader user who arrives from another app is told where they are and then
 * hears each state change without having to hunt for it.
 */
export function ActionPageShell({
  titleId,
  title,
  subtitle,
  status,
  primaryAction,
  secondaryAction,
  footnote,
}: ActionPageShellProps) {
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const { token: designToken } = theme.useToken();

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <main
      style={{
        minHeight: '100dvh',
        width: '100%',
        padding: `max(${designToken.padding}px, env(safe-area-inset-top)) max(${designToken.padding}px, env(safe-area-inset-right)) max(${designToken.padding}px, env(safe-area-inset-bottom)) max(${designToken.padding}px, env(safe-area-inset-left))`,
        boxSizing: 'border-box',
        overflowX: 'hidden',
        display: 'grid',
        placeItems: 'center',
        background: designToken.colorBgLayout,
      }}
      aria-labelledby={titleId}
    >
      <Card style={{ width: '100%', maxWidth: 560, overflowWrap: 'anywhere' }}>
        <Flex vertical gap={20} aria-live="polite">
          <div>
            <Typography.Title
              ref={titleRef}
              id={titleId}
              level={2}
              tabIndex={-1}
              style={{ marginBottom: designToken.marginXS, outline: 'none' }}
            >
              {title}
            </Typography.Title>
            <Typography.Text type="secondary">{subtitle}</Typography.Text>
          </div>
          {status}
          <Flex gap={12} wrap>
            {primaryAction}
            {secondaryAction}
          </Flex>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            {footnote}
          </Typography.Paragraph>
        </Flex>
      </Card>
    </main>
  );
}
