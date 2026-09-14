import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { RbacPolicyPrototypePage } from './RbacPolicyPrototypePage';

afterEach(cleanup);

const renderPrototype = () =>
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <RbacPolicyPrototypePage />
    </ConfigProvider>
  );

describe('RBAC policy prototype responsive layout (real browser)', () => {
  it('renders the board form without horizontal page overflow', async () => {
    renderPrototype();
    await screen.findByRole('heading', { name: 'Permissions prototype' });

    const root = screen.getByTestId('rbac-policy-prototype');
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
    expect(screen.getByText('Who can see and manage this board')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add user/group' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Apply preview/ })).toBeVisible();
  });

  it('adds one existing group as one independently editable entry', async () => {
    renderPrototype();
    await act(async () => userEvent.click(screen.getByRole('button', { name: 'Add user/group' })));
    const picker = screen.getByLabelText(
      'Select one person or group for Who can see and manage this board'
    );

    await act(async () => userEvent.click(picker));
    const securityOption = await screen.findByText('Security', { exact: true });
    await act(async () => userEvent.click(securityOption));

    expect(screen.getByRole('combobox', { name: 'Security role' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove access entry for Security' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Add selected access entry' })
    ).not.toBeInTheDocument();
  });

  it('renders and operates the inherited branch form without horizontal page overflow', async () => {
    renderPrototype();
    fireEvent.click(screen.getByText('Branch', { selector: '.ant-segmented-item-label' }));

    await screen.findByRole('radio', { name: 'Board defaults' });
    const root = screen.getByTestId('rbac-policy-prototype');
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);

    fireEvent.click(screen.getByRole('radio', { name: 'Shared' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Shared' })).toBeChecked());
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
  });

  it('supports keyboard focus and activation on prototype controls', async () => {
    renderPrototype();
    const context = screen.getByRole('radio', { name: 'Board' });
    const apply = screen.getByRole('button', { name: /Apply preview/ });

    await act(async () => context.focus());
    expect(context).toHaveFocus();
    await act(async () => apply.focus());
    expect(apply).toHaveFocus();
    await act(async () => userEvent.keyboard('{Enter}'));
    expect(await screen.findByText('Fixture updated.')).toBeVisible();
  });
});
