import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BoardsTable } from './BoardsTable';
import { renderWithSettingsShell } from './settingsDrillTestUtils';

describe('BoardsTable create guard', () => {
  it('asks before Back discards a picked background preset', async () => {
    renderWithSettingsShell(
      <BoardsTable client={null} boardById={new Map()} branchById={new Map()} />,
      'boards'
    );
    const confirms = () => document.querySelectorAll('.ant-modal-confirm').length;
    fireEvent.click(screen.getByRole('button', { name: /New Board/ }));
    fireEvent.click(await screen.findByRole('tab', { name: 'CSS' }));
    fireEvent.click(screen.getByText('Preset'));
    // A preset applies via setFieldsValue, which fires no onValuesChange.
    fireEvent.click(screen.getAllByRole('button', { name: /\(/ })[0]);
    fireEvent.click(screen.getByText('Boards'));
    await waitFor(() => expect(confirms()).toBe(1));
  });
});
