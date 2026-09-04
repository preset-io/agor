import { normalizeZoneLayoutPolicy } from '@agor/core/layout/zone-layout';
import type { ZoneLayoutPolicy } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ZoneLayoutPolicyEditor } from './ZoneLayoutPolicyEditor';

async function visibleSelectOption(label: string): Promise<HTMLElement> {
  let option: HTMLElement | undefined;
  await waitFor(() => {
    option = screen
      .getAllByText(label, { selector: '.ant-select-item-option-content' })
      .find((candidate) => {
        const dropdown = candidate.closest('.ant-select-dropdown');
        const bounds = candidate.getBoundingClientRect();
        return (
          dropdown &&
          !dropdown.classList.contains('ant-select-dropdown-hidden') &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      });
    expect(option).toBeVisible();
  });
  return option!;
}

function Harness() {
  const [policy, setPolicy] = useState<ZoneLayoutPolicy>(() =>
    normalizeZoneLayoutPolicy({ mode: 'manual', preset: 'grid', gap: 24 })
  );
  return (
    <AntApp>
      <ZoneLayoutPolicyEditor value={policy} onChange={setPolicy} idPrefix="browser-zone-policy" />
      <output aria-label="Policy state">{JSON.stringify(policy)}</output>
    </AntApp>
  );
}

describe('ZoneLayoutPolicyEditor (real browser)', () => {
  it('supports pointer, keyboard, focus, and portaled select interaction', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await act(async () =>
      user.click(screen.getByText('List', { selector: '.ant-segmented-item-label' }))
    );
    expect(screen.queryByRole('spinbutton', { name: 'Columns' })).not.toBeInTheDocument();
    expect(
      screen.getByText('List uses one column. It does not change content expansion.')
    ).toBeInTheDocument();

    const density = screen.getByRole('combobox', { name: 'Content expansion' });
    density.focus();
    expect(density).toHaveFocus();
    await act(async () => user.keyboard('[Enter]'));
    const collapse = await visibleSelectOption('Collapse eligible contents');
    expect(collapse.closest('.canvas-layout-controls')).not.toBeNull();
    fireEvent.click(collapse);
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Policy state' })).toHaveTextContent(
        '"density":"collapse"'
      )
    );

    const spacing = screen.getByRole('spinbutton', { name: 'Spacing' });
    await act(async () => user.clear(spacing));
    await act(async () => user.type(spacing, '4'));
    expect(screen.getByRole('status', { name: 'Policy state' })).toHaveTextContent('"gap":4');

    const autoZone = screen.getByRole('switch', { name: 'Auto Zone' });
    autoZone.focus();
    expect(autoZone).toHaveFocus();
    await act(async () => user.keyboard('[Space]'));
    expect(autoZone).toBeChecked();

    const sortBy = screen.getByRole('combobox', { name: 'Sort by' });
    await act(async () => user.click(sortBy));
    await waitFor(() => {
      const priority = screen
        .getAllByText('Priority / rank', { selector: '.ant-select-item-option-content' })
        .find((candidate) => {
          const dropdown = candidate.closest('.ant-select-dropdown');
          const bounds = candidate.getBoundingClientRect();
          return (
            dropdown &&
            !dropdown.classList.contains('ant-select-dropdown-hidden') &&
            bounds.width > 0 &&
            bounds.height > 0
          );
        });
      expect(priority?.closest('.ant-select-dropdown')).not.toBeNull();
      expect(priority).toBeVisible();
    });
  });
});
