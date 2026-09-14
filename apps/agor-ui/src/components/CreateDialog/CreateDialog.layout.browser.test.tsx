import type { AgorClient, Repo, User } from '@agor-live/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { CreateDialog } from './CreateDialog';

// Real Chromium layout with fixture APIs; live managed-app acceptance is separate.
const repo = {
  repo_id: 'home',
  name: 'Teammate memory',
  slug: 'my-org/memory',
  remote_url: 'https://github.com/my-org/memory',
  clone_status: 'ready',
} as Repo;

function renderDialog() {
  agorStore.setState({ ...EMPTY_MAPS });
  render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <CreateDialog
        open
        onClose={vi.fn()}
        currentUser={{ user_id: 'caller', role: 'member' } as User}
        client={
          {
            service: () => ({ find: async () => [repo], get: async () => repo }),
          } as unknown as AgorClient
        }
        availableAgents={[
          { id: 'claude-code', name: 'Claude Code', icon: '🤖', description: 'Claude' },
        ]}
        onCreateBranch={vi.fn()}
        onCreateBoard={vi.fn()}
        onCreateRepo={vi.fn()}
        onCreateLocalRepo={vi.fn()}
      />
    </ConfigProvider>
  );
}

// Intersect the viewport AND every clipping ancestor, not just card rectangles:
// an offscreen/clipped row must never count as initially discoverable.
function visibleRect(element: Element) {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(innerWidth, rect.right);
  let bottom = Math.min(innerHeight, rect.bottom);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clip = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }
  return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function expectFullyVisible(element: Element) {
  const rect = element.getBoundingClientRect();
  const visible = visibleRect(element);
  expect(visible.width).toBeGreaterThan(0);
  expect(visible.height).toBeGreaterThan(0);
  expect(visible.width).toBeGreaterThanOrEqual(rect.width - 1);
  expect(visible.height).toBeGreaterThanOrEqual(rect.height - 1);
}

function expectNoOverflow() {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  const dialog = screen.getByRole('dialog');
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

afterEach(() => {
  cleanup();
  agorStore.setState({ ...EMPTY_MAPS });
});

it.each([
  [320, 568, 1],
  [844, 390, 2],
  [1366, 768, 3],
])('keeps manual personas and Home usable at %ix%i', async (width, height, count) => {
  await page.viewport(width, height);
  renderDialog();
  const first = await screen.findByRole('button', { name: 'Competitive Analyst' });
  await waitFor(() => expectFullyVisible(first));
  const cards = [...screen.getByRole('group', { name: 'Teammate template' }).children];
  expect(
    cards.filter((card) => {
      const visible = visibleRect(card);
      const rect = card.getBoundingClientRect();
      return visible.width >= rect.width - 1 && visible.height >= rect.height - 1;
    }).length
  ).toBeGreaterThanOrEqual(count);
  expectNoOverflow();
  await page
    .getByRole('radiogroup', { name: 'Filter templates by category' })
    .getByText('Operate', { exact: true })
    .click();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  expectNoOverflow();
  expectFullyVisible(screen.getByRole('button', { name: 'Cancel' }));
  expectFullyVisible(screen.getByRole('button', { name: 'Create AI teammate' }));

  await page.getByPlaceholder('e.g. PR Reviewer, Command Center').fill('Responsive Ada');
  await page.getByRole('button', { name: 'Start blank', exact: true }).click();
  expectFullyVisible(screen.getByRole('button', { name: 'Start blank' }));
  await page.getByRole('button', { name: 'Competitive Analyst', exact: true }).click();
  await page.getByRole('textbox', { name: /^Description/ }).fill('Retained description');
  await page.getByRole('button', { name: 'Continue to home →' }).click();
  const heading = await screen.findByRole('heading', { name: 'Choose your teammate’s home' });
  await waitFor(() => expect(heading).toHaveFocus());
  expectFullyVisible(heading);
  expectNoOverflow();
  await page.getByRole('combobox', { name: 'Teammate home repository' }).click();
  await page
    .getByText('Teammate memory — https://github.com/my-org/memory', { exact: true })
    .click();
  await screen.findByText('Clone ready · Push access unchecked · Visibility unknown');
  expect(screen.getByRole('link', { name: 'github.com/my-org/memory' })).toHaveAttribute(
    'href',
    'https://github.com/my-org/memory'
  );
  expect(screen.getByRole('button', { name: 'Create AI teammate' })).toBeDisabled();
  await page.getByRole('checkbox').click();
  expect(screen.getByRole('button', { name: 'Create AI teammate' })).toBeEnabled();
  expectNoOverflow();
  await page.getByRole('button', { name: 'Back to persona' }).click();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Competitive Analyst' })).toHaveFocus()
  );
  expect(screen.getByRole('button', { name: 'Competitive Analyst' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(screen.getByPlaceholderText('e.g. PR Reviewer, Command Center')).toHaveValue(
    'Responsive Ada'
  );
  expect(screen.getByRole('textbox', { name: /^Description/ })).toHaveValue('Retained description');
  expectNoOverflow();
});

it('limits the bounded layout to the manual teammate tab', async () => {
  await page.viewport(1366, 768);
  renderDialog();
  for (const name of ['Branch', 'Board', 'Repository']) {
    await page.getByRole('tab', { name: new RegExp(name) }).click();
    expect(screen.getByRole('dialog')).not.toHaveClass('create-teammate-dialog');
    expect(
      getComputedStyle(screen.getByRole('dialog').querySelector('.ant-modal-body')!).overflowY
    ).toBe('visible');
  }
  await page.getByRole('tab', { name: /Teammate/ }).click();
  expect(screen.getByRole('dialog')).toHaveClass('create-teammate-dialog');
});
