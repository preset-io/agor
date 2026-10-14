import type { MCPCatalogEntry } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Input, Select, Skeleton, Tooltip, Typography, theme } from 'antd';
import { useState } from 'react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import type { RequestedCatalogTool } from '../../utils/teammateBootstrapPrompt';
import { sortToolsForTemplate, type TeammateTemplate } from '../../utils/teammateTemplates';
import { CatalogEntryAvatar } from '../Marketplace/CatalogEntryAvatar';
import {
  ALL_CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  type CategoryFilter,
  DEFAULT_SORT,
  entryTitle,
} from '../Marketplace/catalogPresentation';
import {
  type CatalogFilterState,
  isFilterActive,
  useCatalogSearch,
} from '../Marketplace/useCatalogSearch';

interface Props {
  client: AgorClient | null;
  connected: boolean;
  /** Template picked in step 1; its preferred tools are listed first. */
  template?: TeammateTemplate;
  /** Without a named teammate there is no first session to hand picks to (yet). */
  hasTeammate: boolean;
  /** Tools the user picked; the teammate's first session helps connect them. */
  picked: readonly RequestedCatalogTool[];
  onPickedChange: (picked: RequestedCatalogTool[]) => void;
}

function ToolTile({
  entry,
  picked,
  onToggle,
}: {
  entry: MCPCatalogEntry;
  picked: boolean;
  onToggle: () => void;
}) {
  const { token } = theme.useToken();
  const title = entryTitle(entry);

  return (
    <Tooltip
      title={
        <>
          <strong>{title}</strong>
          <br />
          {entry.benefit}
        </>
      }
      // Skimming the grid shouldn't flash a tooltip on every tile.
      mouseEnterDelay={0.5}
    >
      <Button
        block
        aria-label={title}
        aria-description={entry.benefit}
        aria-pressed={picked}
        // A pick: the primary border plus an inset ring of the same colour (lineWidthBold
        // in total, no size change) on colorPrimaryBg. Tile text keeps its own colours.
        color={picked ? 'primary' : 'default'}
        variant="outlined"
        onClick={onToggle}
        style={{
          height: '100%',
          minHeight: token.controlHeightLG,
          padding: token.paddingXS,
          justifyContent: 'flex-start',
          textAlign: 'left',
          whiteSpace: 'normal',
          ...(picked && {
            boxShadow: `inset 0 0 0 ${token.lineWidthBold - token.lineWidth}px ${token.colorPrimary}`,
            background: token.colorPrimaryBg,
          }),
        }}
      >
        <Flex align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
          {/* Same logos as the Catalog, sized to the tile (28px). */}
          <CatalogEntryAvatar
            iconUrl={entry.icon_url}
            title={title}
            size={token.controlHeightSM + token.sizeXXS}
            style={{ flexShrink: 0 }}
          />
          <Flex vertical style={{ minWidth: 0 }}>
            <Typography.Paragraph
              ellipsis={{ rows: 2 }}
              style={{ margin: 0, fontSize: token.fontSize, overflowWrap: 'break-word' }}
            >
              {title}
            </Typography.Paragraph>
            <Typography.Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
              {CATEGORY_LABELS[entry.category]}
            </Typography.Text>
          </Flex>
        </Flex>
      </Button>
    </Tooltip>
  );
}

export function OnboardingToolsStep({
  client,
  connected,
  template,
  hasTeammate,
  picked,
  onPickedChange,
}: Props) {
  const { token } = theme.useToken();
  const narrow = useMediaQuery('(max-width: 480px)');
  const [filters, setFilters] = useState<CatalogFilterState>({ search: '', sort: DEFAULT_SORT });
  const { matches, status, error, retry } = useCatalogSearch(client, connected, filters, 1);
  // The template orders the default view only; a search or category keeps the Catalog's order.
  const tools = isFilterActive(filters) ? matches : sortToolsForTemplate(matches, template);
  const isPicked = (entry: MCPCatalogEntry) =>
    picked.some((tool) => tool.catalogEntryName === entry.name);
  // Picks are kept by Catalog id, so they survive search and the category filter.
  const toggle = (entry: MCPCatalogEntry) =>
    onPickedChange(
      isPicked(entry)
        ? picked.filter((tool) => tool.catalogEntryName !== entry.name)
        : [...picked, { name: entryTitle(entry), catalogEntryName: entry.name }]
    );

  return (
    <Flex vertical gap={token.marginSM} style={{ flex: '1 1 auto', minHeight: 0 }}>
      <Typography.Paragraph style={{ color: token.colorTextSecondary, margin: 0 }}>
        {hasTeammate
          ? 'Pick the tools you use. Your teammate will help you connect them.'
          : "Pick the tools you use. Name your teammate in step 1 and they'll help you connect them."}
      </Typography.Paragraph>
      <Flex gap={token.marginXS}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search tools"
          aria-label="Search tools"
          value={filters.search}
          onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Select<CategoryFilter>
          prefix="Category"
          aria-label="Filter by category"
          value={filters.category ?? ALL_CATEGORIES}
          onChange={(value) =>
            setFilters((prev) => ({
              ...prev,
              category: value === ALL_CATEGORIES ? undefined : value,
            }))
          }
          options={CATEGORY_OPTIONS}
          popupMatchSelectWidth={false}
          styles={{ prefix: { color: token.colorTextSecondary } }}
          style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '45%' }}
        />
      </Flex>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        {status === 'error' ? (
          <Alert
            type="error"
            showIcon
            title="Could not load the catalog"
            description={error}
            action={
              <Button size="small" onClick={retry}>
                Retry
              </Button>
            }
          />
        ) : status === 'loading' ? (
          <Skeleton active />
        ) : tools.length === 0 ? (
          <Typography.Text type="secondary">
            {filters.search.trim()
              ? `No tools match "${filters.search.trim()}".`
              : 'No tools to show.'}
          </Typography.Text>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${narrow ? 2 : 3}, minmax(0, 1fr))`,
              gap: token.marginXS,
            }}
          >
            {tools.map((item) => (
              <ToolTile
                key={item.name}
                entry={item}
                picked={isPicked(item)}
                onToggle={() => toggle(item)}
              />
            ))}
          </div>
        )}
        <Typography.Paragraph
          type="secondary"
          style={{ fontSize: token.fontSizeSM, margin: `${token.marginSM}px 0 0` }}
        >
          You can connect more tools anytime from the Catalog.
        </Typography.Paragraph>
      </div>
    </Flex>
  );
}
