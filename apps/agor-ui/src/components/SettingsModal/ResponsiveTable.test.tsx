import { fireEvent, render, screen } from '@testing-library/react';
import type { TableProps } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ResponsiveTable } from './ResponsiveTable';

interface Row {
  id: string;
  name: string;
}

// Drive the shell breakpoint deterministically (the hook itself is covered by
// its own suite); ResponsiveTable keys off the same 1024 source of truth.
let mockMobile = false;
vi.mock('../../hooks/useIsMobileViewport', () => ({
  useIsMobileViewport: () => mockMobile,
}));

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

describe('ResponsiveTable', () => {
  it('renders a real AntD table unchanged on the desktop shell (no regression)', () => {
    mockMobile = false;
    render(<ResponsiveTable<Row> columns={columns} dataSource={data} rowKey="id" />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('stacks rows into cards on the mobile shell (no horizontal-scroll table)', () => {
    mockMobile = true;
    render(<ResponsiveTable<Row> columns={columns} dataSource={data} rowKey="id" />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getAllByText('Name')).toHaveLength(2); // one dt per row
    expect(screen.getByRole('button', { name: 'Edit Alpha' })).toBeInTheDocument();
  });

  it('forwards onRow as a keyboard-operable card tap; action taps do not bubble', () => {
    mockMobile = true;
    const onRowClick = vi.fn();
    render(
      <ResponsiveTable<Row>
        columns={columns}
        dataSource={data}
        rowKey="id"
        onRow={(record) => ({ onClick: () => onRowClick(record.id) })}
      />
    );
    const alphaCard = screen.getByText('Alpha').closest('[role="button"]') as HTMLElement;

    fireEvent.click(alphaCard);
    expect(onRowClick).toHaveBeenCalledWith('1');

    onRowClick.mockClear();
    fireEvent.keyDown(alphaCard, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledWith('1');

    // Tapping the row action must not also trigger the row onClick.
    onRowClick.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha' }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('paginates on mobile instead of rendering every row', () => {
    mockMobile = true;
    const many: Row[] = Array.from({ length: 25 }, (_, i) => ({ id: String(i), name: `Row ${i}` }));
    render(
      <ResponsiveTable<Row>
        columns={columns}
        dataSource={many}
        rowKey="id"
        pagination={{ pageSize: 10 }}
      />
    );
    expect(screen.getByText('Row 9')).toBeInTheDocument();
    expect(screen.queryByText('Row 10')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Load more/ }));
    expect(screen.getByText('Row 10')).toBeInTheDocument();
  });

  it('keeps the real Table (not cards) when rowSelection is used, even on mobile', () => {
    mockMobile = true;
    render(
      <ResponsiveTable<Row>
        columns={columns}
        dataSource={data}
        rowKey="id"
        rowSelection={{ selectedRowKeys: [] }}
      />
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});
