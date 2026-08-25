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
      />
    );

    expect(screen.getByLabelText('Primary owner for this board')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /transfer owner/i })).not.toBeInTheDocument();
    expect(screen.getByText('Others — unmatched active workspace members')).toBeInTheDocument();
    expect(screen.getByText(/Used only when no person or group entry matches/)).toBeInTheDocument();
    expect(
      screen.getByLabelText('Add one person or group to Who can see and manage this board')
    ).toBeInTheDocument();
    expect(screen.getByText(/One person or group per entry/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('radio', { name: 'This branch' }));

    await waitFor(() => {
      expect(screen.getByText('Branch access')).toBeInTheDocument();
      expect(screen.getByText(/This policy replaces the board defaults/)).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Add one person or group to Branch access')).toBeEnabled();
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
    expect(screen.getByRole('radio', { name: 'Read' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Read/write' })).toBeInTheDocument();
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
    expect(screen.getByText('Other people’s sharing')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('switch', { name: 'Allow others to use sessions owned by Kasia D.' })
    );
    expect(screen.getByText(/Listed people can run prompts as you/)).toBeInTheDocument();
    expect(
      screen.getByLabelText('Add one person or group to my session sharing')
    ).toBeInTheDocument();
  });
});
