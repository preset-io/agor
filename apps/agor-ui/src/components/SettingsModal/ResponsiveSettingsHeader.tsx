import { Flex, Grid, Typography } from 'antd';
import type { ReactNode } from 'react';

const { Title, Paragraph, Text } = Typography;

export interface ResponsiveSettingsHeaderProps {
  /** Optional persistent panel title, rendered on the header row (left). */
  title?: ReactNode;
  /**
   * One-line description. ALWAYS on its own full-width line, never beside the
   * toolbar — that side-by-side cram was the original layout bug.
   */
  description?: ReactNode;
  /**
   * Search input. Sits at the left of the toolbar row. Pass a bare `<Input>`
   * (no width): the header owns the width so every panel's search is the same
   * size on desktop and full-width on narrow screens.
   */
  search?: ReactNode;
  /** Filter controls (Selects, Segmented, …). Sit at the left, after search. */
  filters?: ReactNode;
  /** Count/total indicator (e.g. "12 boards"). Sits flush at the RIGHT of the toolbar. */
  count?: ReactNode;
  /**
   * Primary create/import action(s). Sit on the header row, right-aligned next
   * to the title (GitHub-style). If no `title` is passed there is no header row,
   * so they fall back to the toolbar's right slot beside the count.
   */
  primaryActions?: ReactNode;
}

/** Desktop width of the shared search input; full-width on narrow screens. */
const SEARCH_WIDTH = 320;

/**
 * Shared header for Workspace Settings list panels. Top to bottom:
 *   1. Header row — title on the LEFT, primary action(s) on the RIGHT
 *      (e.g. "Users" … "+ New User"). Rendered only when a `title` is passed.
 *   2. description — on its OWN full-width line.
 *   3. Toolbar row — search + filters clustered on the LEFT, the count flush on
 *      the RIGHT.
 *
 * When no `title` is passed there is no header row to anchor the primary
 * action(s), so they fall back into the toolbar's right slot beside the count
 * rather than being dropped. On narrow/mobile screens both rows stack vertically
 * and controls go full-width (responsive behavior preserved).
 *
 * The structured slots (rather than one freeform `actions` blob) are deliberate:
 * the API keeps a caller from cramming filters and the primary action into one
 * undifferentiated row. Mirrors the convention of `ListPanelHeader`.
 */
export function ResponsiveSettingsHeader({
  title,
  description,
  search,
  filters,
  count,
  primaryActions,
}: ResponsiveSettingsHeaderProps) {
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;

  // Primary actions sit beside the title when there is one; otherwise they fall
  // back to the toolbar's right slot so the button is never dropped.
  const primaryInHeader = title ? primaryActions : null;
  const primaryInToolbar = title ? null : primaryActions;

  const hasLeft = Boolean(search || filters);
  const hasToolbarRight = count != null || Boolean(primaryInToolbar);

  return (
    <div style={{ width: '100%', minWidth: 0, marginBottom: 16 }}>
      {title && (
        <Flex
          vertical={compact}
          align={compact ? 'stretch' : 'center'}
          justify="space-between"
          gap={compact ? 12 : 16}
          style={{ minWidth: 0 }}
        >
          <Title level={4} style={{ margin: 0, fontWeight: 500, minWidth: 0 }}>
            {title}
          </Title>
          {primaryInHeader && (
            <Flex
              align="center"
              gap={8}
              wrap
              justify={compact ? 'flex-start' : 'flex-end'}
              style={{ width: compact ? '100%' : undefined, flexShrink: 0 }}
            >
              {primaryInHeader}
            </Flex>
          )}
        </Flex>
      )}
      {description && (
        <Paragraph type="secondary" style={{ marginTop: title ? 4 : 0, marginBottom: 0 }}>
          {description}
        </Paragraph>
      )}
      {(hasLeft || hasToolbarRight) && (
        <Flex
          vertical={compact}
          align={compact ? 'stretch' : 'center'}
          justify={hasLeft ? 'space-between' : 'flex-end'}
          gap={compact ? 12 : 16}
          style={{ marginTop: 16, minWidth: 0 }}
        >
          {hasLeft && (
            <Flex
              vertical={compact}
              align={compact ? 'stretch' : 'center'}
              gap={8}
              wrap
              style={{ minWidth: 0, width: compact ? '100%' : undefined }}
            >
              {search && (
                <div style={{ width: compact ? '100%' : SEARCH_WIDTH, minWidth: 0 }}>{search}</div>
              )}
              {filters}
            </Flex>
          )}
          {hasToolbarRight && (
            <Flex
              align="center"
              gap={12}
              wrap
              justify={compact ? 'space-between' : 'flex-end'}
              style={{ width: compact ? '100%' : undefined, flexShrink: 0 }}
            >
              {count != null && (
                <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>
                  {count}
                </Text>
              )}
              {primaryInToolbar}
            </Flex>
          )}
        </Flex>
      )}
    </div>
  );
}
