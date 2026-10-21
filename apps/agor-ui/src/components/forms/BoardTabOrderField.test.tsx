import type { BoardView } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Form } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardTabOrderField } from './BoardTabOrderField';

const ORDER: BoardView[] = ['board', 'chat', 'files'];

afterEach(cleanup);

const renderField = (onChange?: (order: BoardView[]) => void) =>
  render(
    <Form>
      <BoardTabOrderField value={ORDER} onChange={onChange} />
    </Form>
  );

const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('BoardTabOrderField', () => {
  it('marks the first tab as where the board opens', () => {
    renderField(vi.fn());
    expect(within(row('Board')).getByText('Opens here')).toBeTruthy();
    expect(within(row('Chat')).queryByText('Opens here')).toBeNull();
    expect(
      screen.getByText(
        'The first tab is where this board opens for everyone. Everyone can still switch tabs.'
      )
    ).toBeTruthy();
  });

  it('moves tabs up and down, disabled at the ends', () => {
    const onChange = vi.fn();
    renderField(onChange);
    // By label: role queries compute styles, which jsdom cannot for antd buttons.
    const button = (name: string, action: string) =>
      within(row(name)).getByLabelText(action) as HTMLButtonElement;
    expect(button('Board', 'Move up').disabled).toBe(true);
    expect(button('Chat', 'Move down').disabled).toBe(true);
    fireEvent.click(button('Chat', 'Move up'));
    expect(onChange).toHaveBeenCalledWith(['chat', 'board', 'files']);
  });

  it('is read-only for people who cannot edit the board', () => {
    renderField();
    expect(screen.queryByLabelText('Move up')).toBeNull();
    expect(document.querySelector('.anticon-holder')).toBeNull();
    expect(
      screen.getByText('Only people who can edit this board can change the order.')
    ).toBeTruthy();
  });
});
