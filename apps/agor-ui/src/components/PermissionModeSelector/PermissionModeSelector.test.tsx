import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getPermissionModeLabel, PermissionModeSelector } from './PermissionModeSelector';

describe('getPermissionModeLabel', () => {
  it('maps raw Claude modes to human labels', () => {
    expect(getPermissionModeLabel('claude-code', 'default')).toBe('Manual');
    expect(getPermissionModeLabel('claude-code', 'acceptEdits')).toBe('Accept edits');
    expect(getPermissionModeLabel('claude-code', 'bypassPermissions')).toBe('Bypass permissions');
  });

  it('maps codex modes to human labels', () => {
    expect(getPermissionModeLabel('codex', 'allow-all')).toBe('Never ask');
  });
});

describe('PermissionModeSelector', () => {
  it('shows the human label (not the raw value) in the closed control', () => {
    render(<PermissionModeSelector agentic_tool="claude-code" value="acceptEdits" />);
    expect(screen.getByText('Accept edits')).toBeInTheDocument();
  });

  it('renders rich option rows with the raw value and orders bypass last', () => {
    const onChange = vi.fn();
    render(
      <PermissionModeSelector agentic_tool="claude-code" value="default" onChange={onChange} />
    );
    // Open the dropdown.
    fireEvent.mouseDown(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    // Bypass (most autonomous) is always last.
    expect(options[options.length - 1]).toHaveTextContent('Bypass permissions');
    // The raw config value is surfaced for power users.
    expect(within(listbox).getByText('bypassPermissions')).toBeInTheDocument();
    // Two-part description formula is present.
    expect(within(listbox).getByText(/isolated environments only/)).toBeInTheDocument();
  });
});
