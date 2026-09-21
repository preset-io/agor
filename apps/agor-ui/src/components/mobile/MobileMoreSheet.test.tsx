import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { MobileMoreSheet } from './MobileMoreSheet';

function renderSheet() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <MobileMoreSheet
          open
          onClose={vi.fn()}
          boardById={new Map()}
          branchById={new Map()}
          sessionsByBranch={new Map()}
          commentById={new Map()}
          onOpenWorkspaceSettings={vi.fn()}
          onOpenUserSettings={vi.fn()}
        />
      </MemoryRouter>
    </ThemeProvider>
  );
}

describe('MobileMoreSheet appearance controls', () => {
  beforeEach(() => localStorage.clear());

  it('exposes Light, Dark, System and Custom (parity with the desktop menu)', () => {
    renderSheet();
    for (const label of ['Light', 'Dark', 'System', 'Custom']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('persists a System selection without coercing it', () => {
    renderSheet();
    fireEvent.click(screen.getByText('System'));
    expect(localStorage.getItem('agor:themeMode')).toBe('system');
  });

  it('opens the shared theme editor from Edit theme', () => {
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: /edit theme/i }));
    expect(screen.getByText('Custom Theme Editor')).toBeInTheDocument();
  });
});
