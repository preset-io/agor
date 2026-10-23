import type { AgorClient, Branch, User } from '@agor-live/client';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BranchModal } from './BranchModal';
import { makeBranch, makeRepo, makeStubClient, makeUser, renderWithApp } from './testUtils';

vi.mock('./tabs/ScheduleTab', () => ({ ScheduleTab: () => null }));
function renderBranchModal({
  branch,
  currentUser,
  client,
}: {
  branch: Branch;
  currentUser: User;
  client: AgorClient;
}) {
  return renderWithApp(
    <BranchModal
      open
      onClose={() => {}}
      branch={branch}
      repo={makeRepo()}
      sessions={[]}
      client={client}
      currentUser={currentUser}
    />
  );
}
describe('BranchModal — placement entry point', () => {
  it('offers Move on board in Work Context below Board and above Issue', async () => {
    const user = makeUser({ role: 'admin' });
    const { client } = makeStubClient({ owners: [user], users: [user] });
    renderBranchModal({
      branch: makeBranch({ board_id: 'board-1' as Branch['board_id'] }),
      currentUser: user,
      client,
    });
    const move = screen.getByText('Move on board…').closest('button')!;
    expect(move.disabled).toBe(false);
    const workContext = screen.getByText('Work Context').closest('div');
    expect(workContext?.contains(move)).toBe(true);
    expect(
      screen.getByText('Board').compareDocumentPosition(move) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      move.compareDocumentPosition(screen.getByText('Issue')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('does not offer a usable placement action for a branch without a board', () => {
    const user = makeUser({ role: 'admin' });
    const { client } = makeStubClient({ owners: [user], users: [user] });
    renderBranchModal({ branch: makeBranch({ board_id: undefined }), currentUser: user, client });
    expect(screen.getByText('Move on board…').closest('button')?.disabled).toBe(true);
  });
});
