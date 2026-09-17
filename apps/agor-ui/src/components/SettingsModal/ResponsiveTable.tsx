import { Button, Empty, Flex, Spin, Table, type TableProps, Typography, theme } from 'antd';
import { useState } from 'react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { COMPACT_SETTINGS_MEDIA_QUERY } from '../../utils/deviceDetection';
import { pressableProps } from '../../utils/pressableProps';

/**
 * Drop-in AntD Table replacement that stacks rows into cards below the settings
 * family's compact breakpoint (AntD `md`), so wide tables fit a phone and 768px+
 * keeps the desktop table. Cards expose the same columns, forward `onRow`, and
 * paginate. A table using rowSelection / expandable stays a Table at every width.
 */

type Row = Record<string, unknown>;

interface MinimalColumn {
  key?: React.Key;
  title?: React.ReactNode;
  dataIndex?: string | number | readonly (string | number)[];
  render?: (value: unknown, record: Row, index: number) => React.ReactNode;
}

const DEFAULT_MOBILE_PAGE_SIZE = 20;

function cellValue(record: Row, dataIndex: MinimalColumn['dataIndex']): unknown {
  if (dataIndex == null) return undefined;
  const path = Array.isArray(dataIndex) ? dataIndex : [dataIndex];
  let current: unknown = record;
  for (const key of path) {
    if (current == null) return undefined;
    current = (current as Row)[key as string];
  }
  return current;
}

// Bucketed by the explicit `actions` key, never by display text, so a retitled column keeps its footer slot
const isActionColumn = (col: MinimalColumn): boolean => col.key === 'actions';

function pageSizeFor(pagination: TableProps<object>['pagination']): number {
  if (pagination && typeof pagination === 'object' && pagination.pageSize)
    return pagination.pageSize;
  return DEFAULT_MOBILE_PAGE_SIZE;
}

export function ResponsiveTable<RecordType extends object>(props: TableProps<RecordType>) {
  const isCompact = useMediaQuery(COMPACT_SETTINGS_MEDIA_QUERY);
  const { token } = theme.useToken();
  const [visibleCount, setVisibleCount] = useState(() => pageSizeFor(props.pagination));

  // Wide layout, or features the card layout can't faithfully represent.
  if (!isCompact || props.rowSelection || props.expandable) {
    return <Table<RecordType> {...props} />;
  }

  const { dataSource, columns, rowKey, loading, onRow, pagination } = props;

  if (loading) {
    return (
      <Flex justify="center" style={{ padding: token.paddingLG }}>
        <Spin />
      </Flex>
    );
  }

  const rows = (dataSource ?? []) as unknown as Row[];
  if (rows.length === 0) {
    return (
      <Flex align="center" justify="center" style={{ minHeight: 200 }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </Flex>
    );
  }

  const cols = ((columns ?? []) as unknown as MinimalColumn[]).filter(Boolean);
  const fieldCols = cols.filter((c) => !isActionColumn(c));
  const actionCols = cols.filter(isActionColumn);

  const paginationDisabled = pagination === false;
  const visibleRows = paginationDisabled ? rows : rows.slice(0, visibleCount);

  const keyFor = (record: Row, index: number): React.Key => {
    if (typeof rowKey === 'function') {
      return (rowKey as (r: RecordType) => React.Key)(record as RecordType);
    }
    if (typeof rowKey === 'string') return (record[rowKey] as React.Key) ?? index;
    return index;
  };

  return (
    <Flex vertical gap={token.marginSM}>
      {visibleRows.map((record, index) => {
        const rowProps = onRow?.(record as RecordType, index);
        const activate = rowProps?.onClick as (() => void) | undefined;
        return (
          <div
            key={keyFor(record, index)}
            {...(activate ? pressableProps(activate) : undefined)}
            style={{
              border: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
              // Match the Home/settings card radius (GlassPanel / AntD Card use LG).
              borderRadius: token.borderRadiusLG,
              padding: token.paddingSM,
              background: token.colorBgContainer,
              cursor: activate ? 'pointer' : undefined,
              ...rowProps?.style,
            }}
          >
            <dl
              style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: token.marginXXS }}
            >
              {fieldCols.map((col, colIndex) => {
                const content = col.render
                  ? col.render(cellValue(record, col.dataIndex), record, index)
                  : (cellValue(record, col.dataIndex) as React.ReactNode);
                if (content == null || content === '') return null;
                return (
                  <Flex
                    key={col.key ?? colIndex}
                    justify="space-between"
                    align="baseline"
                    gap={token.margin}
                  >
                    <dt style={{ margin: 0, flexShrink: 0 }}>
                      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                        {col.title}
                      </Typography.Text>
                    </dt>
                    <dd style={{ margin: 0, minWidth: 0, textAlign: 'right' }}>{content}</dd>
                  </Flex>
                );
              })}
            </dl>
            {actionCols.length > 0 && (
              // Stop row activation from firing when a row action is tapped.
              <Flex
                justify="flex-end"
                wrap
                gap={token.marginXXS}
                style={{ marginTop: token.marginXS }}
                onClick={(e) => e.stopPropagation()}
              >
                {actionCols.map((col, colIndex) => (
                  <div key={col.key ?? `action-${colIndex}`}>
                    {col.render?.(cellValue(record, col.dataIndex), record, index)}
                  </div>
                ))}
              </Flex>
            )}
          </div>
        );
      })}
      {!paginationDisabled && visibleCount < rows.length && (
        <Button block onClick={() => setVisibleCount((c) => c + pageSizeFor(pagination))}>
          Load more ({rows.length - visibleCount})
        </Button>
      )}
    </Flex>
  );
}
