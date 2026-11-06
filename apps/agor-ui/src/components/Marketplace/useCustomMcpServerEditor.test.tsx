import type { MCPServer } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpMemberPolicyState } from '../../hooks/useMcpMemberPolicy';
import type { MCPServerEditModalProps } from '../MCPServer/MCPServerEditModal';
import {
  type UseCustomMcpServerEditorOptions,
  useCustomMcpServerEditor,
} from './useCustomMcpServerEditor';

const memberPolicy = vi.hoisted(() => ({
  current: {} as Partial<McpMemberPolicyState>,
}));
vi.mock('../../hooks/useMcpMemberPolicy', () => ({
  useMcpMemberPolicy: () => memberPolicy.current,
}));

vi.mock('../MCPServer/MCPServerEditModal', () => ({
  MCPServerEditModal: ({
    embedded,
    server,
    onCreated,
    onClose,
    offeredTransports,
    mutationAllowed,
  }: MCPServerEditModalProps) => (
    <div data-testid="editor" data-embedded={String(embedded)}>
      <span>{server ? `editing ${server.name}` : 'creating'}</span>
      <span>{offeredTransports?.join(',')}</span>
      <span>{mutationAllowed ? 'allowed' : 'blocked'}</span>
      <button type="button" onClick={() => onCreated?.({ mcp_server_id: 'new' } as MCPServer)}>
        create
      </button>
      <button type="button" onClick={onClose}>
        cancel
      </button>
    </div>
  ),
}));

const READY: Partial<McpMemberPolicyState> = {
  policy: 'allow_private_only',
  canConfigure: true,
  loading: false,
  error: null,
};

const OWN = {
  mcp_server_id: 'own',
  name: 'own',
  display_name: 'Own Server',
  owner_user_id: 'alice',
  transport: 'http',
} as unknown as MCPServer;

let editor: ReturnType<typeof useCustomMcpServerEditor>;
function Harness(props: Partial<UseCustomMcpServerEditorOptions>) {
  editor = useCustomMcpServerEditor({
    client: null,
    connected: true,
    connecting: false,
    authGeneration: 1,
    currentUser: { user_id: 'alice', role: 'member' } as never,
    ...props,
  });
  return (
    <>
      <div data-testid="tab-bar">{editor.button}</div>
      <div data-testid="compact">{editor.iconButton}</div>
      {editor.view && (
        <section aria-label={editor.view.current}>
          <span>{[...editor.view.trail, editor.view.current].join(' / ')}</span>
          {editor.view.editor}
        </section>
      )}
    </>
  );
}

const addButtons = () => screen.getAllByRole('button', { name: 'Add custom server' });

describe('useCustomMcpServerEditor', () => {
  beforeEach(() => {
    memberPolicy.current = READY;
  });

  it('adds in place and reports the server once its view closes, not when it is created', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    // A secondary action; the compact copy is icon-only, named by its aria-label.
    expect(addButtons()).toHaveLength(2);
    for (const button of addButtons()) expect(button).not.toHaveClass('ant-btn-primary');
    expect(screen.getByTestId('compact').querySelector('button')).not.toHaveTextContent(
      'Add custom server'
    );
    fireEvent.click(addButtons()[1]);
    const view = screen.getByRole('region', { name: 'Add custom server' });
    expect(screen.getByTestId('editor')).toHaveAttribute('data-embedded', 'true');
    // Members are held to remote transports.
    expect(view).not.toHaveTextContent('stdio');
    fireEvent.click(screen.getByText('create'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('cancel'));
    expect(onClose).toHaveBeenCalledWith('new');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('reports nothing when the add view is left without creating', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(addButtons()[0]);
    fireEvent.click(screen.getByText('cancel'));
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it('edits a server in place under a My Servers breadcrumb and reports it on close', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    act(() => editor.openEdit(OWN, 'configuration'));
    expect(screen.getByRole('region', { name: 'Edit configuration' })).toHaveTextContent(
      'My Servers / Own Server / Edit configuration'
    );
    expect(screen.getByText('editing own')).toBeVisible();
    expect(screen.getByText('allowed')).toBeVisible();
    fireEvent.click(screen.getByText('cancel'));
    expect(onClose).toHaveBeenCalledWith('own');
  });

  it('blocks editing a server the caller may not change', () => {
    memberPolicy.current = { ...READY, canConfigure: false };
    render(<Harness />);
    act(() => editor.openEdit(OWN, 'credential'));
    expect(screen.getByRole('region', { name: 'Edit credential' })).toBeVisible();
    expect(screen.getByText('blocked')).toBeVisible();
  });

  it.each([
    { name: 'policy refuses', policy: { ...READY, canConfigure: false }, props: {} },
    { name: 'policy is pending', policy: { ...READY, loading: true }, props: {} },
    { name: 'connection is lost', policy: READY, props: { connecting: true } },
  ])('disables the add button when the $name', ({ policy, props }) => {
    memberPolicy.current = policy;
    render(<Harness {...props} />);
    for (const button of addButtons()) expect(button).toBeDisabled();
  });
});
