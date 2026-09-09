import { fireEvent, screen } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../BranchModal/testUtils';
import { BoardFormFields, extractBoardFormValues } from './BoardFormFields';

function BoardFormHarness({
  onRead,
  canEditGeneral,
}: {
  onRead: (values: ReturnType<typeof extractBoardFormValues>) => void;
  canEditGeneral?: boolean;
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
      <BoardFormFields form={form} canEditGeneral={canEditGeneral} />
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

describe('BoardFormFields general-settings permission gating', () => {
  it('disables name and description when the caller lacks board.edit', () => {
    renderWithApp(<BoardFormHarness onRead={vi.fn()} canEditGeneral={false} />);

    expect(screen.getByPlaceholderText('My Board')).toBeDisabled();
    expect(screen.getByPlaceholderText('Optional description...')).toBeDisabled();
    expect(screen.getByText("You don't have permission to edit this board.")).toBeInTheDocument();
  });

  it('swaps the appearance tab for a read-only notice instead of leaving live controls that bypass disabling', () => {
    renderWithApp(<BoardFormHarness onRead={vi.fn()} canEditGeneral={false} />);
    fireEvent.click(screen.getByRole('tab', { name: 'CSS' }));

    expect(
      screen.getByText("You don't have permission to edit this board's appearance.")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Background mode')).not.toBeInTheDocument();
  });

  it('leaves name and description editable by default (create flow)', () => {
    renderWithApp(<BoardFormHarness onRead={vi.fn()} />);

    expect(screen.getByPlaceholderText('My Board')).not.toBeDisabled();
    expect(screen.getByPlaceholderText('Optional description...')).not.toBeDisabled();
  });
});
