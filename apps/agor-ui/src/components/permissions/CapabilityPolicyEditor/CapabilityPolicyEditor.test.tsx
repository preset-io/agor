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
  it('shows immutable ownership and explicit Others fallback semantics', () => {
    const value = cloneBoardPrototypeFixture('shared-board');
    renderWithTheme(
      <BoardCapabilityPolicyForm
        value={value}
        onChange={() => undefined}
        principals={PROTOTYPE_PRINCIPALS}
        subjects={PROTOTYPE_SUBJECTS}
        sampleBranchOwnerUserId={PROTOTYPE_USERS.leo}
      />
    );

    expect(screen.getByText(/Ownership is fixed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /transfer owner/i })).not.toBeInTheDocument();
    expect(screen.getByText('Others — unmatched active workspace members')).toBeInTheDocument();
    expect(screen.getByText('Fallback, not an additional grant')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Add one person or group to Who can see and manage this board')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/One entry represents one existing person or workspace group/)
    ).toBeInTheDocument();
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
    expect(screen.getByText('Inherited policy is read only here')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'This branch' }));

    await waitFor(() => {
      expect(screen.getByText('Branch access')).toBeInTheDocument();
      expect(screen.getByText('This branch no longer follows board defaults')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Add one person or group to Branch access')).toBeEnabled();
  });

  it('warns before making a shared policy private', async () => {
    const Harness = () => {
      const [value, setValue] = useState(cloneBoardPrototypeFixture('shared-board'));
      return (
        <BoardCapabilityPolicyForm
          value={value}
          onChange={setValue}
          principals={PROTOTYPE_PRINCIPALS}
          subjects={PROTOTYPE_SUBJECTS}
          sampleBranchOwnerUserId={PROTOTYPE_USERS.leo}
        />
      );
    };
    renderWithTheme(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: /Private/i }));
    expect(await screen.findByText('Make this owner-only?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make private' })).toBeInTheDocument();
  });

  it('uses one role dropdown plus file access with no capability checkboxes', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit access for Kasia D.' }));

    expect(screen.getByLabelText('Kasia D. role')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Kasia D. file access' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Customize access/)).not.toBeInTheDocument();
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
    expect(
      screen.getByText(/You cannot change them, even if your branch role is Manager/)
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('switch', { name: 'Allow others to prompt sessions owned by Kasia D.' })
    );
    expect(
      screen.getByText('Sharing a session means sharing your agent-tool home')
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Add one person or group to my session sharing')
    ).toBeInTheDocument();
  });
});
