import { Flex, Grid, Typography } from 'antd';
import type { ReactNode } from 'react';

const { Title, Paragraph, Text } = Typography;

export interface ResponsiveSettingsHeaderProps {
  /** Optional persistent panel title, rendered on its own line first. */
  title?: ReactNode;
  /**
   * One-line description. ALWAYS rendered on its own full-width line, never
   * beside the toolbar — that side-by-side cram was the reported layout bug.
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
  /** Count/total indicator (e.g. "12 boards"). Sits at the right, before actions. */
  count?: ReactNode;
  /** Primary create/import action(s). Sit at the right of the toolbar row. */
  primaryActions?: ReactNode;
}

/** Desktop width of the shared search input; full-width on narrow screens. */
const SEARCH_WIDTH = 320;

/**
 * Shared header for Workspace Settings list panels. Top to bottom: an optional
 * title, the description on its OWN full-width line, then a toolbar row with
 * search + filters clustered on the LEFT and an optional count + primary
 * action(s) on the RIGHT. On narrow/mobile screens the toolbar stacks
 * vertically and the search input goes full-width (responsive behavior
 * preserved from the merged version).
 *
 * The structured slots (rather than one freeform `actions` blob) are deliberate:
 * the API itself keeps a caller from cramming filters and the primary action
 * into one undifferentiated row, which is what made the old header read as
 * "overwhelming". Mirrors the convention of `ListPanelHeader`
 * (title → description → search-left / actions-right).
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
  const hasLeft = Boolean(search || filters);
  const hasRight = count != null || Boolean(primaryActions);

  return (
    <div style={{ width: '100%', minWidth: 0, marginBottom: 16 }}>
      {title && (
        <Title level={4} style={{ margin: 0, fontWeight: 500 }}>
          {title}
        </Title>
      )}
      {description && (
        <Paragraph type="secondary" style={{ marginTop: title ? 4 : 0, marginBottom: 0 }}>
          {description}
        </Paragraph>
      )}
      {(hasLeft || hasRight) && (
        <Flex
          vertical={compact}
          align={compact ? 'stretch' : 'center'}
          justify="space-between"
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
          {hasRight && (
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
              {primaryActions}
            </Flex>
          )}
        </Flex>
      )}
    </div>
  );
}
