/**
 * Searching gateway channels by target branch name works with the store's
 * branch map empty (Step 3): the table reads its channels' target branches by id.
 */
import type { AgorClient, Branch, GatewayChannel, User } from '@agor-live/client';
import { fireEvent, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useAgorStore } from '../../store/agorStore';
import { selectBranchById } from '../../store/selectors';
import { mount, withTestAuthority } from '../../test/harness';
import { GatewayChannelsTable } from './GatewayChannelsTable';

const user = { user_id: 'user-1', name: 'Ada', role: 'admin' } as User;
const channel = {
  id: 'channel-1',
  name: 'Team Slack',
  channel_type: 'slack',
  channel_key: 'slack:team',
  target_branch_id: 'branch-1',
  agor_user_id: 'user-1',
  created_by: 'user-1',
  enabled: true,
  config: {},
  last_message_at: null,
} as unknown as GatewayChannel;
const branch = { branch_id: 'branch-1', name: 'support-desk', archived: false } as Branch;

withTestAuthority('user-1:admin:1');

it("reads a channel's unloaded target branch by id, so its name is searchable", async () => {
  const find = vi.fn(async () => [branch]);
  const client = { service: () => ({ find }) } as unknown as AgorClient;
  function Table() {
    const branchById = useAgorStore(selectBranchById);
    return (
      <GatewayChannelsTable
        client={client}
        gatewayChannelById={new Map([[channel.id, channel]])}
        branchById={branchById}
        userById={new Map([[user.user_id, user]])}
        mcpServerById={new Map()}
        currentUser={user}
      />
    );
  }
  mount(<Table />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'support-desk' } });
  expect(await screen.findByText('Team Slack')).toBeVisible();
  expect(find).toHaveBeenCalledWith({
    query: { branch_id: { $in: ['branch-1'] }, archived: false, $limit: 1 },
  });
});
