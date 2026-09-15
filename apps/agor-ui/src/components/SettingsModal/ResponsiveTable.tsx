import { Empty, Flex, Grid, Spin, Table, type TableProps, Typography, theme } from 'antd';

/**
 * Drop-in AntD Table replacement that becomes a stacked card list on narrow
 * viewports so wide settings tables stop overflowing horizontally on mobile.
 *
 * At >= md it renders `<Table {...props} />` verbatim, so desktop is unchanged.
 * Below md each row becomes a card of label/value pairs (one per titled column)
 * with the row's `actions` column rendered as a footer. Columns are the single
 * source of truth for both layouts.
 */

type Row = Record<string, unknown>;

interface MinimalColumn {
  key?: React.Key;
  title?: React.ReactNode;
  dataIndex?: string | number | readonly (string | number)[];
  render?: (value: unknown, record: Row, index: number) => React.ReactNode;
}

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

// Actions columns carry the row's buttons, not a labelled value.
const isActionColumn = (col: MinimalColumn): boolean =>
  col.key === 'actions' || col.title == null || col.title === '';

export function ResponsiveTable<RecordType extends object>(props: TableProps<RecordType>) {
  const screens = Grid.useBreakpoint();
  const { token } = theme.useToken();

  // Only stack when a small breakpoint has affirmatively matched (xs/sm) and md
  // has not. When no breakpoint is known (SSR/first paint, or a test env without
  // a real matchMedia) this stays on the desktop Table, so desktop is unchanged.
  const isNarrow = (screens.xs === true || screens.sm === true) && !screens.md;
  if (!isNarrow) return <Table<RecordType> {...props} />;

  const { dataSource, columns, rowKey, loading } = props;

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

  const keyFor = (record: Row, index: number): React.Key => {
    if (typeof rowKey === 'function')
      return (rowKey as (r: RecordType) => React.Key)(record as RecordType);
    if (typeof rowKey === 'string') return (record[rowKey] as React.Key) ?? index;
    return index;
  };

  return (
    <Flex vertical gap={token.marginSM}>
      {rows.map((record, index) => (
        <div
          key={keyFor(record, index)}
          style={{
            border: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
            padding: token.paddingSM,
            background: token.colorBgContainer,
          }}
        >
          <Flex vertical gap={token.marginXXS}>
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
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: token.fontSizeSM, flexShrink: 0 }}
                  >
                    {col.title}
                  </Typography.Text>
                  <div style={{ minWidth: 0, textAlign: 'right' }}>{content}</div>
                </Flex>
              );
            })}
          </Flex>
          {actionCols.length > 0 && (
            <Flex
              justify="flex-end"
              wrap
              gap={token.marginXXS}
              style={{ marginTop: token.marginXS }}
            >
              {actionCols.map((col, colIndex) => (
                <div key={col.key ?? `action-${colIndex}`}>
                  {col.render?.(cellValue(record, col.dataIndex), record, index)}
                </div>
              ))}
            </Flex>
          )}
        </div>
      ))}
    </Flex>
  );
}
