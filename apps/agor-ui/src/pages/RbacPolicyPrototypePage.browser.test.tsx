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
    expect(
      screen.getByLabelText('Add one person or group to Who can see and manage this board')
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /Apply locally/i })).toBeVisible();
  });

  it('adds one existing group as one independently editable entry', async () => {
    renderPrototype();
    const picker = screen.getByLabelText(
      'Add one person or group to Who can see and manage this board'
    );

    await act(async () => userEvent.click(picker));
    const securityOption = await screen.findByText('Security', { exact: true });
    await act(async () => userEvent.click(securityOption));

    expect(screen.getByRole('button', { name: 'Edit access for Security' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Add selected access entry' })
    ).not.toBeInTheDocument();
  });

  it('renders and operates the inherited branch form without horizontal page overflow', async () => {
    renderPrototype();
    fireEvent.click(screen.getByText('Branch', { selector: '.ant-segmented-item-label' }));

    await screen.findByText('Inherited summary');
    const root = screen.getByTestId('rbac-policy-prototype');
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);

    fireEvent.click(screen.getByRole('radio', { name: 'This branch' }));
    await waitFor(() => expect(screen.getByText('Branch access')).toBeVisible());
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
  });

  it('supports keyboard focus and activation on prototype controls', async () => {
    renderPrototype();
    const context = screen.getByRole('radio', { name: 'Board' });
    const apply = screen.getByRole('button', { name: /Apply locally/i });

    await act(async () => context.focus());
    expect(context).toHaveFocus();
    await act(async () => apply.focus());
    expect(apply).toHaveFocus();
    await act(async () => userEvent.keyboard('{Enter}'));
    expect(await screen.findByText('Applied to this local fixture only')).toBeVisible();
  });
});
