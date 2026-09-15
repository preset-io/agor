import { render, screen } from '@testing-library/react';
import { Grid, type TableProps } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveTable } from './ResponsiveTable';

interface Row {
  id: string;
  name: string;
}

const columns: TableProps<Row>['columns'] = [
  { title: 'Name', dataIndex: 'name', key: 'name' },
  {
    title: 'Actions',
    key: 'actions',
    render: (_v, record) => <button type="button">Edit {record.name}</button>,
  },
];

const data: Row[] = [
  { id: '1', name: 'Alpha' },
  { id: '2', name: 'Beta' },
];

function renderTable() {
  return render(<ResponsiveTable<Row> columns={columns} dataSource={data} rowKey="id" />);
}

afterEach(() => vi.restoreAllMocks());

describe('ResponsiveTable', () => {
  it('renders a real AntD table unchanged at >= md (no desktop regression)', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ xs: true, sm: true, md: true, lg: true });
    renderTable();

    // A genuine <table> with column headers — the desktop rendering path.
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('stacks rows into cards below md (no horizontal-scroll table)', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ xs: true, sm: true, md: false });
    renderTable();

    // No <table> element on mobile — rows become labelled cards instead.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    // Field label from the column title is shown once per row.
    expect(screen.getAllByText('Name')).toHaveLength(2);
    // The actions column still renders per row.
    expect(screen.getByRole('button', { name: 'Edit Alpha' })).toBeInTheDocument();
  });
});
