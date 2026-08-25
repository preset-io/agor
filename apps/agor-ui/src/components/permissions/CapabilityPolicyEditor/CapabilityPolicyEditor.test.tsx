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
    expect(screen.getByLabelText('Search people and groups')).toBeInTheDocument();
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
    expect(screen.getByLabelText('Search people and groups')).toBeEnabled();
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

  it('shows three product-level controls instead of low-level session and terminal switches', () => {
    const value = cloneBranchPrototypeFixture('overridden-branch');
    renderWithTheme(
      <BranchCapabilityPolicyForm
        value={value}
        onChange={() => undefined}
        principals={PROTOTYPE_PRINCIPALS}
        subjects={PROTOTYPE_SUBJECTS}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit access for Kasia D.' }));
    fireEvent.click(screen.getByRole('button', { name: /Customize access/i }));

    expect(screen.getByRole('checkbox', { name: /View branch/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Work in own sessions/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Manage branch/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: /Create own sessions/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Open own terminal/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Terminal is available automatically only when/)).toBeInTheDocument();
  });
});
