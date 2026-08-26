import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  cloneBoardPrototypeFixture,
  cloneBranchPrototypeFixture,
  EFFECTIVE_ACCESS_SUBJECTS,
  PROTOTYPE_PRINCIPALS,
  PROTOTYPE_USERS,
} from '@/pages/rbac-policy-prototype/fixtures';
import { BoardCapabilityPolicyForm } from './BoardCapabilityPolicyForm';
import { BranchCapabilityPolicyForm } from './BranchCapabilityPolicyForm';

const renderWithTheme = (node: React.ReactNode) =>
  render(<ConfigProvider theme={{ token: { motion: false } }}>{node}</ConfigProvider>);

describe('shared capability policy forms', () => {
  it('shows the primary owner and explicit Others fallback semantics', () => {
    const value = cloneBoardPrototypeFixture('shared-board');
    renderWithTheme(
      <BoardCapabilityPolicyForm
        value={value}
        onChange={() => undefined}
        principals={PROTOTYPE_PRINCIPALS}
        subjects={EFFECTIVE_ACCESS_SUBJECTS}
        sampleBranchOwnerUserId={PROTOTYPE_USERS.leo}
        currentUserId={PROTOTYPE_USERS.kasia}
      />
    );

    expect(screen.getByLabelText('Primary owner for this board')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /transfer owner/i })).not.toBeInTheDocument();
    expect(screen.getByText('Others')).toBeInTheDocument();
    expect(screen.getByLabelText('Others fallback details')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add user/group' })).toBeInTheDocument();
  });

  it('adds one independently editable group entry through an explicit CRUD row', async () => {
    const Harness = () => {
      const [value, setValue] = useState(cloneBoardPrototypeFixture('shared-board'));
      return (
        <BoardCapabilityPolicyForm
          value={value}
          onChange={setValue}
          principals={PROTOTYPE_PRINCIPALS}
          subjects={EFFECTIVE_ACCESS_SUBJECTS}
          sampleBranchOwnerUserId={PROTOTYPE_USERS.leo}
          currentUserId={PROTOTYPE_USERS.kasia}
        />
      );
    };
    renderWithTheme(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Add user/group' }));
    const picker = screen.getByRole('combobox', {
      name: 'Select one person or group for Who can see and manage this board',
    });
    expect(picker).toHaveFocus();
    fireEvent.mouseDown(picker);
    fireEvent.click(await screen.findByText('Release Engineers'));

    await waitFor(() => {
      expect(screen.getByLabelText('Release Engineers role')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Add user/group' })).toBeEnabled();
    expect(screen.queryByRole('combobox', { name: /Select one person or group/ })).toBeNull();
  }, 30_000);

  it('switches an inherited branch to an editable complete override', async () => {
    const initial = cloneBranchPrototypeFixture('inherited-branch');
    let latestValue = initial;
    const Harness = () => {
      const [value, setValue] = useState(initial);
      return (
        <BranchCapabilityPolicyForm
          value={value}
          onChange={(nextValue) => {
            latestValue = nextValue;
            setValue(nextValue);
          }}
          principals={PROTOTYPE_PRINCIPALS}
          subjects={EFFECTIVE_ACCESS_SUBJECTS}
          currentUserId={PROTOTYPE_USERS.kasia}
        />
      );
    };
    renderWithTheme(<Harness />);

    expect(screen.getByRole('radio', { name: 'Board defaults' })).toBeChecked();
    expect(screen.getByText('Branch access')).toBeInTheDocument();
    expect(screen.queryByLabelText('Branch access sharing mode')).not.toBeInTheDocument();
    expect(screen.queryByText('My sessions')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Session sharing/ }));
    expect(
      screen.getByRole('switch', { name: 'Allow others to use sessions owned by Kasia D.' })
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Shared' }));

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Shared' })).toBeChecked();
    });
    expect(latestValue.binding_mode).toBe('override');
    expect(latestValue.override_config).toEqual(initial.inherited_config);
    expect(screen.getByRole('button', { name: 'Add user/group' })).toBeEnabled();
    expect(
      screen.getByRole('switch', { name: 'Allow others to use sessions owned by Kasia D.' })
    ).toBeEnabled();
    expect(screen.getByText('Seb V. shares with')).toBeInTheDocument();
  }, 30_000);

  it('warns before replacing a shared inherited package with a private override', async () => {
    const initial = cloneBranchPrototypeFixture('inherited-branch');
    let latestValue = initial;
    const Harness = () => {
      const [value, setValue] = useState(initial);
      return (
        <BranchCapabilityPolicyForm
          value={value}
          onChange={(nextValue) => {
            latestValue = nextValue;
            setValue(nextValue);
          }}
          principals={PROTOTYPE_PRINCIPALS}
          subjects={EFFECTIVE_ACCESS_SUBJECTS}
          currentUserId={PROTOTYPE_USERS.kasia}
        />
      );
    };
    renderWithTheme(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
    expect(await screen.findByText(/Make this owner-only/)).toBeInTheDocument();
    expect(latestValue.binding_mode).toBe('inherit');

    fireEvent.click(screen.getByRole('button', { name: 'Make private' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Private' })).toBeChecked());
    expect(latestValue.binding_mode).toBe('override');
    expect(latestValue.override_config?.access).toMatchObject({
      sharing_mode: 'private',
      entries: [],
      others: { preset: 'none', capabilities: [], fs_access: 'none' },
    });
    expect(latestValue.override_config?.session_sharing).toEqual(
      initial.inherited_config?.session_sharing
    );
  });

  it('warns before making a shared policy private without rendering an empty-state panel', async () => {
    const Harness = () => {
      const [value, setValue] = useState(cloneBoardPrototypeFixture('shared-board'));
      return (
        <BoardCapabilityPolicyForm
          value={value}
          onChange={setValue}
          principals={PROTOTYPE_PRINCIPALS}
          subjects={EFFECTIVE_ACCESS_SUBJECTS}
          sampleBranchOwnerUserId={PROTOTYPE_USERS.leo}
          currentUserId={PROTOTYPE_USERS.kasia}
        />
      );
    };
    const { container } = renderWithTheme(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: /Private/i }));
    expect(await screen.findByText(/Make this owner-only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make private' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make private' }));
    await waitFor(() => expect(container.querySelector('.ant-empty')).not.toBeInTheDocument());
  });

  it('shows every entry as an inline role and file-access row', () => {
    const value = cloneBranchPrototypeFixture('overridden-branch');
    renderWithTheme(
      <BranchCapabilityPolicyForm
        value={value}
        onChange={() => undefined}
        principals={PROTOTYPE_PRINCIPALS}
        subjects={EFFECTIVE_ACCESS_SUBJECTS}
        currentUserId={PROTOTYPE_USERS.kasia}
      />
    );

    expect(screen.getByLabelText('Kasia D. role')).toBeInTheDocument();
    expect(screen.getByLabelText('Security role')).toBeInTheDocument();
    expect(screen.getByLabelText('Mia S. role')).toBeInTheDocument();
    expect(screen.getByLabelText('Others fallback role')).toBeInTheDocument();
    const kasiaFileAccess = screen.getByRole('combobox', {
      name: 'Kasia D. file access',
    });
    expect(kasiaFileAccess).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit access for/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Customize access/)).not.toBeInTheDocument();
  });

  it('keeps effective access out of the main form until requested', () => {
    const value = cloneBoardPrototypeFixture('shared-board');
    renderWithTheme(
      <BoardCapabilityPolicyForm
        value={value}
        onChange={() => undefined}
        principals={PROTOTYPE_PRINCIPALS}
        subjects={EFFECTIVE_ACCESS_SUBJECTS}
        sampleBranchOwnerUserId={PROTOTYPE_USERS.leo}
        currentUserId={PROTOTYPE_USERS.kasia}
      />
    );

    expect(screen.queryByLabelText('Effective-access preview for sample principals')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check effective access' }));
    expect(
      screen.getByLabelText('Effective-access preview for sample principals')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide effective access' })).toBeInTheDocument();
  });

  it('edits the same nested branch config from board defaults', async () => {
    const Harness = () => {
      const [value, setValue] = useState(cloneBoardPrototypeFixture('shared-board'));
      return (
        <BoardCapabilityPolicyForm
          value={value}
          onChange={setValue}
          principals={PROTOTYPE_PRINCIPALS}
          subjects={EFFECTIVE_ACCESS_SUBJECTS}
          sampleBranchOwnerUserId={PROTOTYPE_USERS.leo}
          currentUserId={PROTOTYPE_USERS.kasia}
        />
      );
    };
    renderWithTheme(<Harness />);

    fireEvent.click(screen.getByRole('tab', { name: /Branch defaults/ }));
    const sessionSharing = await screen.findByRole('button', { name: /Session sharing/ });
    expect(screen.queryByText('My sessions')).not.toBeInTheDocument();
    fireEvent.click(sessionSharing);
    expect(screen.getByText('My sessions')).toBeInTheDocument();
    expect(screen.getByText(/branches using these settings/)).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Allow others to use sessions owned by Kasia D.' })
    ).toBeEnabled();
  });

  it('keeps personal session sharing owner-authored and foreign rules read only', () => {
    const initial = cloneBranchPrototypeFixture('overridden-branch');
    const Harness = () => {
      const [value, setValue] = useState(initial);
      return (
        <BranchCapabilityPolicyForm
          value={value}
          onChange={setValue}
          principals={PROTOTYPE_PRINCIPALS}
          subjects={EFFECTIVE_ACCESS_SUBJECTS}
          currentUserId={PROTOTYPE_USERS.kasia}
        />
      );
    };
    renderWithTheme(<Harness />);

    expect(screen.getByRole('button', { name: /Session sharing/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    fireEvent.click(screen.getByRole('button', { name: /Session sharing/ }));
    expect(screen.getByText('Seb V. shares with')).toBeInTheDocument();
    expect(screen.getByText('GTM')).toBeInTheDocument();
    expect(screen.getByText('Other people’s sessions')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('switch', { name: 'Allow others to use sessions owned by Kasia D.' })
    );
    expect(
      screen.getByText(/Listed people can prompt your sessions from your home/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/use their Agor-managed environment variables and credentials/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Learn more in the FAQ.' })).toHaveAttribute(
      'href',
      'https://agor.live/faq#session-sharing-home-access'
    );
    expect(
      screen.getByLabelText('Add one person or group to my session sharing')
    ).toBeInTheDocument();
  });
});
