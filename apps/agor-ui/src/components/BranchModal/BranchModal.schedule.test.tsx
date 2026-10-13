/**
 * The Schedules tab edits in place (no dialog over the branch editor) and its
 * draft joins the branch editor's unsaved-changes guard.
 */
import type { AgorClient } from '@agor-live/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StandaloneSettingsDrillProvider } from '../SettingsModal/SettingsDrill';
import { BranchModal } from './BranchModal';
import { makeBranch, makeRepo, makeStubClient, makeUser, renderWithApp } from './testUtils';

vi.mock('../ScheduleForm', () => ({
  ScheduleForm: (props: { onDirtyChange?: (dirty: boolean) => void }) => (
    <button type="button" onClick={() => props.onDirtyChange?.(true)}>
      Make schedule dirty
    </button>
  ),
}));

// The Schedules tab subscribes to schedule events; the shared stub has no realtime.
const withRealtime = (client: AgorClient) =>
  ({
    ...client,
    service: (path: string) => ({ on() {}, off() {}, ...client.service(path) }),
  }) as unknown as AgorClient;

const confirms = () => document.querySelectorAll('.ant-modal-confirm').length;

function branchModal(embedded: boolean) {
  const owner = makeUser({ user_id: 'user-1', role: 'admin' });
  return (
    <BranchModal
      embedded={embedded}
      open
      onClose={vi.fn()}
      branch={makeBranch({ created_by: owner.user_id })}
      repo={makeRepo()}
      sessions={[]}
      client={withRealtime(makeStubClient({ owners: [owner] }).client)}
      currentUser={owner}
      defaultTab="schedule"
    />
  );
}

async function openNewSchedule() {
  fireEvent.click((await screen.findAllByRole('button', { name: /New( schedule)?$/ }))[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Make schedule dirty' }));
}

describe('BranchModal schedules', () => {
  it('guards Back in Settings while a schedule draft is unsaved', async () => {
    renderWithApp(
      <StandaloneSettingsDrillProvider section="branches">
        {branchModal(true)}
      </StandaloneSettingsDrillProvider>
    );
    await openNewSchedule();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Branches'));
    await waitFor(() => expect(confirms()).toBe(1));
  });

  it('opens the schedule form inside the standalone branch dialog, not over it', async () => {
    renderWithApp(branchModal(false));
    await openNewSchedule();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('New schedule')).toBeInTheDocument();
  });
});
