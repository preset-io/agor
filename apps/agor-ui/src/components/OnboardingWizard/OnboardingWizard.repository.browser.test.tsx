import type { AgorClient, User } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { afterEach, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { repositorySetupMessage } from '../../utils/repositorySetupMessage';
import { OnboardingWizard } from './OnboardingWizard';

vi.mock('../EmojiPickerInput/EmojiPickerInput', () => ({
  EmojiPickerInput: () => <span>🙂</span>,
}));
afterEach(cleanup);

it('shows prefetch status inline and keeps required setup failure retryable without duplicating the board', async () => {
  agorStore.setState({ ...EMPTY_MAPS });
  const user = {
    user_id: 'synthetic-member',
    role: 'member',
    name: 'Synthetic',
    email: 'synthetic@example.invalid',
    preferences: {
      onboarding: {
        boardId: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
        teammateDisplayName: 'Helper',
      },
    },
  } as unknown as User;
  const boards = { create: vi.fn(async (data: object) => ({ ...data, created_by: user.user_id })) };
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: (name: string) =>
      name === 'boards' ? boards : { get: vi.fn(async () => user), on: vi.fn(), off: vi.fn() },
  } as unknown as AgorClient;
  const failure = repositorySetupMessage(undefined, { code: 403 });
  const onComplete = vi
    .fn()
    .mockRejectedValueOnce(new Error(failure))
    .mockResolvedValueOnce(undefined);
  render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <OnboardingWizard
        open
        initialStep="done"
        client={client}
        user={user}
        onUpdateUser={async () => {}}
        onComplete={onComplete}
        repositorySetupNotice="Background repository setup did not finish. Try completing setup to retry."
      />
    </ConfigProvider>
  );
  await waitFor(() =>
    expect(screen.getByText('Your teammate workspace needs setup')).toBeVisible()
  );
  expect(document.querySelector('.ant-message')).toBeNull();
  fireEvent.click(screen.getByText(/meet helper/i).closest('button')!);
  await waitFor(() => expect(screen.getByText(failure)).toBeVisible());
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(document.querySelector('.ant-message')).toBeNull();
  const retry = screen.getByText(/^try again →$/i).closest('button')!;
  expect(retry).toBeEnabled();
  fireEvent.click(retry);
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
  expect(boards.create).toHaveBeenCalledTimes(1);
  expect(onComplete.mock.calls[1][0].boardId).toBe(onComplete.mock.calls[0][0].boardId);
});
