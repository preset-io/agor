import { fireEvent, screen } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../BranchModal/testUtils';
import { BoardFormFields, extractBoardFormValues } from './BoardFormFields';

function BoardFormHarness({
  onRead,
}: {
  onRead: (values: ReturnType<typeof extractBoardFormValues>) => void;
}) {
  const [form] = Form.useForm();
  return (
    <Form
      form={form}
      initialValues={{
        access_mode: 'shared',
        default_others_can: 'session',
        default_others_fs_access: 'read',
        owner_ids: ['user-1'],
      }}
    >
      <BoardFormFields form={form} rbacEnabled />
      <button type="button" onClick={() => onRead(extractBoardFormValues(form))}>
        Read values
      </button>
    </Form>
  );
}

describe('BoardFormFields permissions', () => {
  it('offers and persists an explicit None default, then allows changing away', () => {
    const onRead = vi.fn();
    renderWithApp(<BoardFormHarness onRead={onRead} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Permissions' }));
    const selector = screen.getByRole('combobox', { name: 'Default others can' });

    fireEvent.mouseDown(selector);
    fireEvent.click(screen.getByText('None', { selector: '.ant-select-item-option-content' }));
    expect(screen.getByText('None')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read values' }));
    expect(onRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ default_others_can: 'none' })
    );

    fireEvent.mouseDown(selector);
    fireEvent.click(screen.getByText('View', { selector: '.ant-select-item-option-content' }));
    expect(screen.getByText('View')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read values' }));
    expect(onRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ default_others_can: 'view' })
    );
  });
});
