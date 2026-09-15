import { Button, Empty, Flex, Spin, Table, type TableProps, Typography, theme } from 'antd';
import { useState } from 'react';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';

/**
 * Drop-in AntD Table replacement that becomes a stacked card list on the mobile
 * shell so wide settings tables stop overflowing horizontally on a phone.
 *
 * On the desktop shell it renders `<Table {...props} />` verbatim (unchanged),
 * gated on the same 1024px breakpoint as the shell so 768-1023px keeps the
 * desktop table. Each card exposes the same columns (dl/dt/dd label/value pairs,
 * actions column as a footer), forwards `onRow` (row tap + keyboard), and paginates.
 * rowSelection / expandable are not represented as cards, so a table using them
 * stays a Table even on mobile rather than silently losing behavior.
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

// Bucketed by the explicit `actions` key, not an empty title, so a titleless
// value/icon column isn't mistaken for the row's action buttons.
const isActionColumn = (col: MinimalColumn): boolean =>
  col.key === 'actions' || col.title === 'Actions';

function pageSizeFor(pagination: TableProps<object>['pagination']): number {
  if (pagination && typeof pagination === 'object' && pagination.pageSize)
    return pagination.pageSize;
  return DEFAULT_MOBILE_PAGE_SIZE;
}

export function ResponsiveTable<RecordType extends object>(props: TableProps<RecordType>) {
  const isMobile = useIsMobileViewport();
  const { token } = theme.useToken();
  const [visibleCount, setVisibleCount] = useState(() => pageSizeFor(props.pagination));

  // Desktop shell, or features the card layout can't faithfully represent.
  if (!isMobile || props.rowSelection || props.expandable) {
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
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginBlock: token.marginLG }} />;
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
            role={activate ? 'button' : undefined}
            tabIndex={activate ? 0 : undefined}
            onClick={activate}
            onKeyDown={
              activate
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activate();
                    }
                  }
                : undefined
            }
            style={{
              border: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
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
