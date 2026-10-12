import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompactNotice } from './CompactNotice';

afterEach(cleanup);

describe('CompactNotice', () => {
  it('renders one line with its severity, message and dismiss control', () => {
    const onDismiss = vi.fn();
    render(
      <CompactNotice
        type="warning"
        message="Linear isn’t connected."
        onDismiss={onDismiss}
        dismissLabel="Dismiss notice"
        role="status"
        data-testid="notice"
      />
    );
    const notice = screen.getByTestId('notice');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveAttribute('data-notice-type', 'warning');
    expect(screen.getByText('Linear isn’t connected.')).toHaveStyle({ fontSize: '12px' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('keeps compact controls and adds only an invisible touch area on mobile', () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    try {
      render(
        <CompactNotice
          type="error"
          message="Failed"
          details={[{ label: 'Error', value: 'raw', code: true }]}
          actions={[{ label: 'Resume', onClick: vi.fn() }]}
          onDismiss={vi.fn()}
        />
      );
      for (const name of ['Details', 'Resume', 'Dismiss']) {
        const button = screen.getByRole('button', { name });
        expect(button).toHaveStyle({ height: '20px' });
        expect(button.querySelector('[data-touch-hit-area]')).toHaveStyle({
          position: 'absolute',
        });
      }
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('renders at most two actions', () => {
    const onClick = vi.fn();
    render(
      <CompactNotice
        type="error"
        message="Failed"
        actions={[
          { label: 'One', onClick },
          { label: 'Two', onClick },
          { label: 'Three', onClick },
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Two' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Three' })).toBeNull();
  });

  it('discloses raw details inline and copies them verbatim', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const raw = 'Executor exited unexpectedly with code 137.';
    render(
      <CompactNotice
        type="error"
        message="The agent stopped unexpectedly."
        details={[{ label: 'Error', value: raw, code: true }]}
      />
    );
    const toggle = screen.getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    expect(screen.queryByText(raw)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toHaveTextContent(raw);
    expect(toggle).toHaveTextContent(/^Details$/);
    expect(toggle.querySelector('.anticon-up')).not.toBeNull();
    expect(screen.getByText(raw)).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`Error: ${raw}`));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it.each([
    ['error', 'Error'],
    ['warning', 'Warning'],
    ['info', 'Info'],
    ['neutral', 'Note'],
  ] as const)('names the %s severity for screen readers', (type, label) => {
    render(<CompactNotice type={type} message="Message" />);
    expect(screen.getByRole('img', { name: label })).toBeInTheDocument();
  });

  it('labels the details region by its toggle and collapses it on Escape, returning focus', () => {
    render(
      <CompactNotice
        type="error"
        message="Failed"
        details={[{ label: 'Error', value: 'raw cause', code: true }]}
      />
    );
    const toggle = screen.getByRole('button', { name: 'Details' });
    fireEvent.click(toggle);
    const region = screen.getByRole('region', { name: 'Technical details' });
    expect(region).toHaveAttribute('id', toggle.getAttribute('aria-controls'));
    expect(region).toHaveTextContent('raw cause');
    const copyButton = screen.getByRole('button', { name: 'Copy details' });
    copyButton.focus();
    fireEvent.keyDown(copyButton, { key: 'Escape' });
    expect(screen.queryByRole('region')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('announces copy success and failure in a polite live region', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('no'));
    Object.assign(navigator, { clipboard: { writeText } });
    const execCommand = vi.fn(() => false);
    Object.assign(document, { execCommand });
    const { container } = render(
      <CompactNotice
        type="error"
        message="Failed"
        details={[{ label: 'Error', value: 'raw', code: true }]}
      />
    );
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await waitFor(() => expect(live).toHaveTextContent('Copied to clipboard'));
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    await waitFor(() => expect(live).toHaveTextContent("Couldn't copy"));
    expect(screen.getByRole('button', { name: "Couldn't copy" })).toBeVisible();
  });

  it('drops control transitions when the user prefers reduced motion', () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...matchMedia(query),
      matches: query === '(prefers-reduced-motion: reduce)',
    })) as typeof window.matchMedia;
    try {
      render(
        <CompactNotice
          type="info"
          message="Working"
          details={[{ label: 'Error', value: 'raw', code: true }]}
        />
      );
      expect(screen.getByRole('button', { name: 'Details' })).toHaveStyle({ transition: 'none' });
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it('lists technical facts under the lead and copies all of it as plain text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <CompactNotice
        type="warning"
        message="The agent stopped waiting for approval."
        detailsLead="Approval requests expire after 10 minutes."
        details={[
          { label: 'Error', value: 'Permission request timed out after 600000ms.', code: true },
          { label: 'Task', value: 'task-1', code: true },
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const region = screen.getByRole('region', { name: 'Technical details' });
    expect(within(region).getByText('Error').closest('dt')).not.toBeNull();
    expect(within(region).getByText('task-1').closest('dd')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'Approval requests expire after 10 minutes.\nError: Permission request timed out after 600000ms.\nTask: task-1'
      )
    );
  });
});
