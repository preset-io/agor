import type { MCPServer } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpMemberPolicyState } from '../../hooks/useMcpMemberPolicy';
import type { MCPServerEditModalProps } from '../MCPServer/MCPServerEditModal';
import { type UseAddCustomMcpServerOptions, useAddCustomMcpServer } from './useAddCustomMcpServer';

const memberPolicy = vi.hoisted(() => ({
  current: {} as Partial<McpMemberPolicyState>,
}));
vi.mock('../../hooks/useMcpMemberPolicy', () => ({
  useMcpMemberPolicy: () => memberPolicy.current,
}));

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

const READY: Partial<McpMemberPolicyState> = {
  policy: 'allow_private_only',
  canConfigure: true,
  loading: false,
  error: null,
};

function Harness(props: Partial<UseAddCustomMcpServerOptions>) {
  const { button, iconButton, modal } = useAddCustomMcpServer({
    client: null,
    connected: true,
    connecting: false,
    authGeneration: 1,
    currentUser: { user_id: 'alice', role: 'member' } as never,
    ...props,
  });
  return (
    <>
      <div data-testid="tab-bar">{button}</div>
      <div data-testid="empty">{button}</div>
      <div data-testid="compact">{iconButton}</div>
      {modal}
    </>
  );
}

const addButtons = () => screen.getAllByRole('button', { name: 'Add custom server' });

describe('useAddCustomMcpServer', () => {
  beforeEach(() => {
    memberPolicy.current = READY;
  });

  it('opens one form from any copy of the button and reports creation as it happens', () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<Harness onCreated={onCreated} onClose={onClose} />);
    // A primary action; the compact copy is icon-only, named by its aria-label.
    expect(addButtons()).toHaveLength(3);
    for (const button of addButtons()) expect(button).toHaveClass('ant-btn-primary');
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
    { name: 'policy refuses', policy: { ...READY, canConfigure: false }, props: {} },
    { name: 'policy is pending', policy: { ...READY, loading: true }, props: {} },
    { name: 'connection is lost', policy: READY, props: { connecting: true } },
  ])('disables the button when the $name', ({ policy, props }) => {
    memberPolicy.current = policy;
    render(<Harness {...props} />);
    for (const button of addButtons()) expect(button).toBeDisabled();
  });
});
