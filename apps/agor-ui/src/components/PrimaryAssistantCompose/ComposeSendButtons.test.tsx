import type { Branch } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposeSendButtons } from './ComposeSendButtons';

const ada = {
  branch_id: 'branch-ada',
  name: 'ada',
  custom_context: { teammate: { kind: 'teammate', displayName: 'Ada' } },
} as unknown as Branch;

describe('ComposeSendButtons', () => {
  it('names both actions in the full layout', () => {
    const onSend = vi.fn();
    render(<ComposeSendButtons branch={ada} submitting={null} onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send & open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send in background' }));
    expect(onSend.mock.calls).toEqual([['open'], ['background']]);
  });

  it('keeps the open action in the compact menu, with accessible names on both buttons', async () => {
    const onSend = vi.fn();
    render(<ComposeSendButtons branch={ada} submitting={null} compact onSend={onSend} />);
    const background = screen.getByRole('button', { name: 'Send in background' });
    expect(background).toHaveTextContent('Send');
    expect(screen.queryByRole('button', { name: 'Send & open' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More send options' }));
    fireEvent.click(await screen.findByText('Send & open'));
    expect(onSend).toHaveBeenCalledWith('open');

    fireEvent.click(background);
    expect(onSend).toHaveBeenLastCalledWith('background');
  });

  it('disables both compact buttons while a send is in flight', () => {
    render(<ComposeSendButtons branch={ada} submitting="open" compact onSend={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send in background' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /More send options/ })).toBeDisabled();
  });
});
