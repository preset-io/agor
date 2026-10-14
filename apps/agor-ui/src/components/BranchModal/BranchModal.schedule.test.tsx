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
  ScheduleForm: (props: { onDraftChange?: (isDirty: (() => boolean) | null) => void }) => (
    <button type="button" onClick={() => props.onDraftChange?.(() => true)}>
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

function branchModal(embedded: boolean, onClose = vi.fn()) {
  const owner = makeUser({ user_id: 'user-1', role: 'admin' });
  return (
    <BranchModal
      embedded={embedded}
      open
      onClose={onClose}
      branch={makeBranch({ created_by: owner.user_id })}
      repo={makeRepo()}
      sessions={[]}
      client={withRealtime(makeStubClient({ owners: [owner], users: [owner] }).client)}
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
    expect(screen.getByRole('button', { name: 'Make schedule dirty' })).toBeInTheDocument();
  });

  // Text queries: role queries over the whole branch editor are slow in jsdom.
  const tab = (label: string) => screen.getByText(label).closest('[role="tab"]') as HTMLElement;

  async function saveBranchChange() {
    fireEvent.click(tab('General'));
    const notes = await screen.findByPlaceholderText<HTMLTextAreaElement>(
      'Freeform notes about this branch...'
    );
    await waitFor(() => expect(notes.disabled).toBe(false));
    fireEvent.change(notes, { target: { value: 'Saved note' } });
    fireEvent.click(screen.getByText('Save Changes'));
  }

  it('saves the branch but asks before Save closes over a schedule draft', async () => {
    const onClose = vi.fn();
    renderWithApp(
      <StandaloneSettingsDrillProvider section="branches">
        {branchModal(true, onClose)}
      </StandaloneSettingsDrillProvider>
    );
    await openNewSchedule();
    await saveBranchChange();

    await waitFor(() => expect(confirms()).toBe(1));
    // The draft is shown behind the question; Keep editing stays on it.
    expect(tab('Schedules')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByText('Keep editing'));
    await waitFor(() => expect(confirms()).toBe(0));
    expect(screen.getByText('Make schedule dirty')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  }, 30_000);

  it('closes after the branch save once the schedule draft is discarded', async () => {
    const onClose = vi.fn();
    renderWithApp(branchModal(false, onClose));
    await openNewSchedule();
    await saveBranchChange();

    fireEvent.click(await screen.findByText('Discard'));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  }, 30_000);
});
