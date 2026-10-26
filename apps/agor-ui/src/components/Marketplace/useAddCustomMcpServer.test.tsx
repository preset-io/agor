import type { MCPServer } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MCPServerEditModalProps } from '../MCPServer/MCPServerEditModal';
import type { MCPServerCapabilityContext } from '../MCPServer/memberPolicy';
import { type UseAddCustomMcpServerOptions, useAddCustomMcpServer } from './useAddCustomMcpServer';

vi.mock('../MCPServer/MCPServerEditModal', () => ({
  MCPServerEditModal: ({ open, onCreated, onClose, offeredTransports }: MCPServerEditModalProps) =>
    open ? (
      <div role="dialog" aria-label="Add MCP server">
        <span>{offeredTransports?.join(',')}</span>
        <button type="button" onClick={() => onCreated?.({ mcp_server_id: 'new' } as MCPServer)}>
          create
        </button>
        <button type="button" onClick={onClose}>
          close
        </button>
      </div>
    ) : null,
}));

const capability: MCPServerCapabilityContext = {
  connectionReady: true,
  role: 'member',
  isAdmin: false,
  policy: 'allow_private_only',
  userId: 'alice',
  canConfigure: true,
};

function Harness(props: Partial<UseAddCustomMcpServerOptions>) {
  const { button, iconButton, modal } = useAddCustomMcpServer({
    client: null,
    currentUser: { user_id: 'alice', role: 'member' } as never,
    authGeneration: 1,
    capability,
    policyState: { pending: false, hint: '' },
    ...props,
  });
  return (
    <>
      <div data-testid="toolbar">{button}</div>
      <div data-testid="empty">{button}</div>
      <div data-testid="compact">{iconButton}</div>
      {modal}
    </>
  );
}

const addButtons = () => screen.getAllByRole('button', { name: /Add custom server/ });

describe('useAddCustomMcpServer', () => {
  it('opens one form from any copy of the button and reports creation as it happens', () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<Harness onCreated={onCreated} onClose={onClose} />);
    // The compact copy is icon-only, named by its aria-label.
    expect(addButtons()).toHaveLength(3);
    expect(screen.getByTestId('compact').querySelector('button')).not.toHaveTextContent(
      'Add custom server'
    );
    fireEvent.click(addButtons()[2]);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    // Members are held to remote transports.
    expect(screen.getByRole('dialog')).not.toHaveTextContent('stdio');
    fireEvent.click(screen.getByText('create'));
    expect(onCreated).toHaveBeenCalledWith({ mcp_server_id: 'new' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('close'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    { name: 'policy refuses', options: { capability: { ...capability, canConfigure: false } } },
    { name: 'policy is pending', options: { policyState: { pending: true, hint: 'Loading' } } },
    {
      name: 'connection is lost',
      options: { capability: { ...capability, connectionReady: false } },
    },
  ])('disables the button when the $name', ({ options }) => {
    render(<Harness {...options} />);
    for (const button of addButtons()) expect(button).toBeDisabled();
  });
});
