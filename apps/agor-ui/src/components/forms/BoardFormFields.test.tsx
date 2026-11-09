import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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

function FreshBoardFormHarness({
  onRead,
}: {
  onRead: (values: ReturnType<typeof extractBoardFormValues>) => void;
}) {
  const [form] = Form.useForm();
  return (
    <Form form={form}>
      <BoardFormFields form={form} />
      <button type="button" onClick={() => onRead(extractBoardFormValues(form))}>
        Read values
      </button>
    </Form>
  );
}

describe('BoardFormFields create defaults', () => {
  it('creates a private board that grants Others nothing unless the creator shares it', () => {
    const onRead = vi.fn();
    renderWithApp(<FreshBoardFormHarness onRead={onRead} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read values' }));
    expect(onRead).toHaveBeenLastCalledWith(
      expect.objectContaining({
        access_mode: 'private',
        default_others_can: 'none',
        default_others_fs_access: 'none',
      })
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Permissions' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Shared' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read values' }));
    expect(onRead).toHaveBeenLastCalledWith(
      expect.objectContaining({
        access_mode: 'shared',
        default_others_can: 'none',
        default_others_fs_access: 'none',
      })
    );
  });

  it('does not bring back a Shared grant after switching to Private and back', async () => {
    const onRead = vi.fn();
    const pick = (combobox: HTMLElement, option: string) => {
      fireEvent.mouseDown(combobox);
      fireEvent.click(screen.getByText(option, { selector: '.ant-select-item-option-content' }));
    };
    const readValues = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read values' }));
      return onRead.mock.lastCall?.[0];
    };
    renderWithApp(<FreshBoardFormHarness onRead={onRead} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Permissions' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Shared' }));
    const fsAccessLabel = await screen.findByText('Default filesystem access');
    pick(screen.getByRole('combobox', { name: 'Default others can' }), 'Own Sessions');
    pick(
      within(fsAccessLabel.closest('.ant-form-item') as HTMLElement).getByRole('combobox'),
      'Read'
    );
    expect(readValues()).toMatchObject({
      access_mode: 'shared',
      default_others_can: 'session',
      default_others_fs_access: 'read',
    });

    fireEvent.click(screen.getByRole('radio', { name: /^Private/ }));
    await waitFor(() =>
      expect(screen.queryByText('Default filesystem access')).not.toBeInTheDocument()
    );
    expect(readValues()).toMatchObject({
      access_mode: 'private',
      default_others_can: 'none',
      default_others_fs_access: 'none',
    });

    fireEvent.click(screen.getByRole('radio', { name: 'Shared' }));
    await screen.findByText('Default filesystem access');
    expect(readValues()).toMatchObject({
      access_mode: 'shared',
      default_others_can: 'none',
      default_others_fs_access: 'none',
    });
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
      screen.getByText('You need edit access to change how this board looks.')
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Background mode')).not.toBeInTheDocument();
  });

  it('leaves name and description editable by default (create flow)', () => {
    renderWithApp(<BoardFormHarness onRead={vi.fn()} />);

    expect(screen.getByPlaceholderText('My Board')).not.toBeDisabled();
    expect(screen.getByPlaceholderText('Optional description...')).not.toBeDisabled();
  });
});
