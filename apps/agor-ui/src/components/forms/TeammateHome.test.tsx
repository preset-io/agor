import type { AgorClient, Repo, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeammateHome } from './TeammateHome';

const user = { user_id: 'caller-a', role: 'member' } as User;
const repo = {
  repo_id: 'owned',
  slug: 'me/memory',
  name: 'My memory',
  remote_url: 'https://github.com/me/memory',
  clone_status: 'ready',
} as Repo;
function setup(overrides: Partial<React.ComponentProps<typeof TeammateHome>> = {}) {
  const get = vi.fn(async () => repo);
  const find = vi.fn(async () => [repo]);
  const create = vi.fn(async () => ({ repo_id: repo.repo_id }));
  const patch = vi.fn(async () => user);
  const client = {
    service: (name: string) =>
      name === 'repos' ? { get, find } : name === 'users' ? { patch } : { create },
  } as unknown as AgorClient;
  const props = {
    client,
    user,
    onChange: vi.fn(),
    onReadyChange: vi.fn(),
    acknowledged: false,
    onAcknowledgedChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<TeammateHome {...props} />), props, get, find, create, patch };
}
const click = (text: string) =>
  fireEvent.click(screen.getByText(text).closest('button') ?? screen.getByText(text));
describe('TeammateHome', () => {
  it('does not auto-select or clone a registered repository, and labels access honestly', async () => {
    const { props, create, rerender } = setup();
    await waitFor(() => expect(props.onReadyChange).toHaveBeenCalledWith(false));
    expect(props.onChange).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    rerender(<TeammateHome {...props} repoId="owned" />);
    expect(
      await screen.findByText('Clone ready · Push access unchecked · Visibility unknown')
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
  it('reuses an existing registration after a lost response instead of cloning again', async () => {
    const { props, create } = setup();
    click('Add a repository');
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: repo.remote_url },
    });
    click('Register repository');
    await waitFor(() => expect(props.onChange).toHaveBeenCalledWith('owned'));
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects credential URLs without displaying their contents or sending them', async () => {
    const { create } = setup();
    click('Add a repository');
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://secret@github.com/me/memory' },
    });
    click('Register repository');
    expect(await screen.findByRole('alert')).not.toHaveTextContent('secret@');
    expect(create).not.toHaveBeenCalled();
  });
  it('saves only the current caller’s Git credential through the existing encrypted patch and clears input', async () => {
    const { patch } = setup();
    click('GitHub repository sign-in');
    fireEvent.change(screen.getByLabelText('GitHub repository token'), {
      target: { value: 'test-only-token' },
    });
    click('Save repository credential');
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('caller-a', {
        env_vars: { GITHUB_TOKEN: 'test-only-token' },
        env_var_scopes: { GITHUB_TOKEN: 'global' },
      })
    );
    expect(screen.getByLabelText('GitHub repository token')).toHaveValue('');
    expect(await screen.findByText(/push access is still unchecked/)).toBeInTheDocument();
  });
  it('does not apply a delayed registration to a replacement caller', async () => {
    let resolve!: (value: Repo[]) => void;
    const { props, find, rerender } = setup();
    await waitFor(() => expect(find).toHaveBeenCalled());
    find.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    click('Add a repository');
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: repo.remote_url },
    });
    click('Register repository');
    rerender(<TeammateHome {...props} user={{ ...user, user_id: 'caller-b' } as User} />);
    await act(async () => resolve([repo]));
    expect(props.onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Repository URL')).toHaveValue('');
  });
});
