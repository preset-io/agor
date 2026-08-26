import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  cloneBoardPrototypeFixture,
  cloneBranchPrototypeFixture,
  PROTOTYPE_PRINCIPALS,
  PROTOTYPE_SUBJECTS,
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
        subjects={PROTOTYPE_SUBJECTS}
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
          subjects={PROTOTYPE_SUBJECTS}
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
  });

  it('switches an inherited branch to an editable complete override', async () => {
    const initial = cloneBranchPrototypeFixture('inherited-branch');
    const Harness = () => {
      const [value, setValue] = useState(initial);
      return (
        <BranchCapabilityPolicyForm
          value={value}
          onChange={setValue}
          principals={PROTOTYPE_PRINCIPALS}
          subjects={PROTOTYPE_SUBJECTS}
          currentUserId={PROTOTYPE_USERS.kasia}
        />
      );
    };
    renderWithTheme(<Harness />);

    expect(screen.getByText('Inherited summary')).toBeInTheDocument();
    expect(screen.getByText('Switch to This branch to edit.')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Allow others to use sessions owned by Kasia D.' })
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'This branch' }));

    await waitFor(() => {
      expect(screen.getByText('Branch access')).toBeInTheDocument();
      expect(
        screen.getByText(/Access, files, and session sharing are configured for this branch/)
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Add user/group' })).toBeEnabled();
    expect(
      screen.getByRole('switch', { name: 'Allow others to use sessions owned by Kasia D.' })
    ).toBeEnabled();
    expect(screen.getByText('Seb V. shares with')).toBeInTheDocument();
  });

  it('warns before making a shared policy private without rendering an empty-state panel', async () => {
    const Harness = () => {
      const [value, setValue] = useState(cloneBoardPrototypeFixture('shared-board'));
      return (
        <BoardCapabilityPolicyForm
          value={value}
          onChange={setValue}
          principals={PROTOTYPE_PRINCIPALS}
          subjects={PROTOTYPE_SUBJECTS}
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
        subjects={PROTOTYPE_SUBJECTS}
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
        subjects={PROTOTYPE_SUBJECTS}
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
          subjects={PROTOTYPE_SUBJECTS}
          sampleBranchOwnerUserId={PROTOTYPE_USERS.leo}
          currentUserId={PROTOTYPE_USERS.kasia}
        />
      );
    };
    renderWithTheme(<Harness />);

    fireEvent.click(screen.getByRole('tab', { name: /Branch defaults/ }));
    expect(await screen.findByText('Session sharing')).toBeInTheDocument();
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
          subjects={PROTOTYPE_SUBJECTS}
          currentUserId={PROTOTYPE_USERS.kasia}
        />
      );
    };
    renderWithTheme(<Harness />);

    expect(screen.getByText('Seb V. shares with')).toBeInTheDocument();
    expect(screen.getByText('GTM')).toBeInTheDocument();
    expect(screen.getByText('Other people’s sessions')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('switch', { name: 'Allow others to use sessions owned by Kasia D.' })
    );
    expect(screen.getByText(/Listed people can run prompts as you/)).toBeInTheDocument();
    expect(
      screen.getByLabelText('Add one person or group to my session sharing')
    ).toBeInTheDocument();
  });
});
