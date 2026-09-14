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
  const getUser = vi.fn(async () => overrides.user ?? user);
  const patch = vi.fn(async () => user);
  const client = {
    service: (name: string) =>
      name === 'repos' ? { get, find } : name === 'users' ? { patch, get: getUser } : { create },
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
  return { ...render(<TeammateHome {...props} />), props, get, find, create, patch, getUser };
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
    click('GitHub token setup (if needed)');
    fireEvent.change(screen.getByLabelText('GitHub repository token'), {
      target: { value: 'test-only-token' },
    });
    await screen.findByText('No GITHUB_TOKEN is saved.');
    fireEvent.click(screen.getByRole('checkbox', { name: /Allow global scope/ }));
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
  it('guides create/register directly with no usable repositories', async () => {
    const { find } = setup();
    find.mockResolvedValue([]);
    click('Refresh repositories');
    expect(await screen.findByText(/No usable home yet/)).toBeVisible();
    expect(screen.getByLabelText('Repository URL')).toBeVisible();
    expect(screen.getByRole('link', { name: /Create a private repository/ })).toBeVisible();
  });
  it('shows exact destination and inspect link independently of a friendly name', async () => {
    setup({ repoId: 'owned' });
    expect(await screen.findByRole('link', { name: 'github.com/me/memory' })).toHaveAttribute(
      'href',
      repo.remote_url
    );
    expect(screen.getByText(/Visibility unknown/)).toBeVisible();
  });
  it('requires both explicit replacement and global-scope consent for a restricted token', async () => {
    const { patch } = setup({
      user: { ...user, env_vars: { GITHUB_TOKEN: { set: true, scope: 'session' } } },
    });
    click('GitHub token setup (if needed)');
    await screen.findByText('GITHUB_TOKEN is already saved (scope: session).');
    fireEvent.change(screen.getByLabelText('GitHub repository token'), {
      target: { value: 'replacement-test-token' },
    });
    const save = screen.getByRole('button', { name: 'Save repository credential' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Replace my existing/ }));
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Allow global scope/ }));
    fireEvent.click(save);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('GitHub repository token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('GitHub repository token')).toHaveValue('');
    expect(screen.getByRole('link', { name: /token creation instructions/ })).toHaveAttribute(
      'href',
      expect.stringContaining('https://docs.github.com/')
    );
  });
  it('fences a new credential installed after the consent screen was loaded', async () => {
    const { getUser, patch } = setup();
    click('GitHub token setup (if needed)');
    await screen.findByText('No GITHUB_TOKEN is saved.');
    fireEvent.change(screen.getByLabelText('GitHub repository token'), {
      target: { value: 'test-token' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Allow global scope/ }));
    getUser.mockResolvedValue({
      ...user,
      env_vars: { GITHUB_TOKEN: { set: true, scope: 'session' } },
    });
    click('Save repository credential');
    expect(await screen.findByRole('alert')).toHaveTextContent(/presence\/scope changed/);
    expect(patch).not.toHaveBeenCalled();
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
