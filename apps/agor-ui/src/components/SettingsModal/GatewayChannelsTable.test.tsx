import type { Branch, GatewayChannel, MCPServer, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { GatewayChannelsTable } from './GatewayChannelsTable';

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <AntdApp>{ui}</AntdApp>
    </MemoryRouter>
  );
}

function makeBranch(): Branch {
  return {
    branch_id: 'branch-1',
    name: 'main',
    ref: 'main',
  } as unknown as Branch;
}

function makeUser(): User {
  return {
    user_id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  } as unknown as User;
}

describe('GatewayChannelsTable identity settings', () => {
  it('collapses Slack post-as and alignment controls into one Identity section', () => {
    const branch = makeBranch();
    const user = makeUser();

    renderWithProviders(
      <GatewayChannelsTable
        client={null}
        gatewayChannelById={new Map<string, GatewayChannel>()}
        branchById={new Map([[branch.branch_id, branch]])}
        userById={new Map([[user.user_id, user]])}
        mcpServerById={new Map<string, MCPServer>()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Add Channel/i }));

    expect(screen.getByText('Identity')).toBeInTheDocument();
    expect(screen.getByText('Align Slack users')).toBeInTheDocument();
    expect(screen.getByText('Run as selected user')).toBeInTheDocument();
    expect(screen.queryByText('Post messages as')).not.toBeInTheDocument();
  });
});
