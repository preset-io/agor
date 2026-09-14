import type { User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TeammateTab, type TeammateTabResult } from './TeammateTab';

vi.mock('../../forms/TeammateHome', () => ({
  TeammateHome: ({
    onChange,
    onReadyChange,
    onAcknowledgedChange,
  }: {
    onChange: (id: string) => void;
    onReadyChange: (value: boolean) => void;
    onAcknowledgedChange: (value: boolean) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onChange('owned-home');
        onReadyChange(true);
        onAcknowledgedChange(true);
      }}
    >
      Confirm owned home
    </button>
  ),
}));
vi.mock('../../EmojiPickerInput/EmojiPickerInput', () => ({ FormEmojiPickerInput: () => null }));
vi.mock('../../AgenticToolConfigurationPicker', () => ({
  AgenticToolConfigurationPicker: () => null,
  INLINE_AGENTIC_CONFIGURATION: 'inline',
}));

it('requires an explicit home and keeps canonical blank source separate from its destination', async () => {
  const formRef = { current: null as (() => Promise<TeammateTabResult | null>) | null };
  const onValidityChange = vi.fn();
  render(
    <TeammateTab
      repoById={new Map()}
      onValidityChange={onValidityChange}
      formRef={formRef}
      availableAgents={[]}
      currentUser={{ user_id: 'user-1', role: 'member' } as User}
    />
  );
  fireEvent.change(screen.getByPlaceholderText('e.g. PR Reviewer, Command Center'), {
    target: { value: 'Ada' },
  });
  expect(await formRef.current?.()).toBeNull();
  fireEvent.click(screen.getByText('Continue to home →'));
  fireEvent.click(await screen.findByText('Confirm owned home'));
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  let result: TeammateTabResult | null | undefined;
  await act(async () => {
    result = await formRef.current?.();
  });
  expect(result).toMatchObject({
    displayName: 'Ada',
    repoId: 'owned-home',
    sourceBranch: 'main',
    sourceRemoteUrl: 'https://github.com/preset-io/agor-teammate.git',
  });
  const boardId = result?.creationBoardId;
  fireEvent.click(screen.getByText('Back to persona'));
  expect(screen.getByPlaceholderText('e.g. PR Reviewer, Command Center')).toHaveValue('Ada');
  fireEvent.click(screen.getByText('Continue to home →'));
  fireEvent.click(await screen.findByText('Confirm owned home'));
  await act(async () => {
    result = await formRef.current?.();
  });
  expect(result?.creationBoardId).toBe(boardId);
  fireEvent.click(screen.getByText('Advanced Teammate Settings'));
  expect(await screen.findByLabelText('Starter source')).toBeInTheDocument();
  expect(screen.queryByLabelText('Starter source URL')).not.toBeInTheDocument();
  fireEvent.mouseDown(screen.getByLabelText('Starter source'));
  fireEvent.click(await screen.findByText('Destination’s own branch'));
  await act(async () => {
    result = await formRef.current?.();
  });
  expect(result?.sourceRemoteUrl).toBeUndefined();
});
