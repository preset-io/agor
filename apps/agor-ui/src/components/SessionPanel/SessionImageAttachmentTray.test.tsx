import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComposerImageAttachment } from './imageAttachments';
import { SessionImageAttachmentTray } from './SessionImageAttachmentTray';

function attachment(overrides: Partial<ComposerImageAttachment> = {}): ComposerImageAttachment {
  return {
    id: 'image-1',
    file: new File(['image'], 'chart.png', { type: 'image/png' }),
    previewUrl: 'blob:chart',
    destination: 'branch',
    status: 'pending',
    ...overrides,
  };
}

describe('SessionImageAttachmentTray', () => {
  it('renders thumbnails with remove controls and top-level batch settings', () => {
    const onRemove = vi.fn();
    const onDestinationChange = vi.fn();

    render(
      <SessionImageAttachmentTray
        attachments={[attachment()]}
        destination="branch"
        onDestinationChange={onDestinationChange}
        onRemove={onRemove}
      />
    );

    expect(screen.getByAltText('chart.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview chart.png' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Batch attachment settings'));
    expect(screen.getByText('Batch attachment settings')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /Temp folder/ }));
    expect(onDestinationChange).toHaveBeenCalledWith('temp');

    fireEvent.click(screen.getByLabelText('Remove chart.png'));
    expect(onRemove).toHaveBeenCalledWith('image-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens and closes a larger image preview from the thumbnail', async () => {
    render(
      <SessionImageAttachmentTray
        attachments={[attachment()]}
        destination="branch"
        onDestinationChange={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview chart.png' }));

    expect(screen.getByRole('dialog', { name: 'Preview chart.png' })).toBeInTheDocument();
    expect(screen.getByAltText('Preview of chart.png')).toHaveAttribute('src', 'blob:chart');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('shows upload and failure states without dropping attachments', () => {
    render(
      <SessionImageAttachmentTray
        attachments={[
          attachment({ id: 'uploading', status: 'uploading' }),
          attachment({
            id: 'failed',
            file: new File(['x'], 'bad.svg', { type: 'image/svg+xml' }),
            previewUrl: undefined,
            status: 'failed',
          }),
        ]}
        destination="branch"
        onDestinationChange={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    expect(screen.getByText('Uploading')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/1 file failed or cannot be uploaded/)).toBeInTheDocument();
    expect(screen.getByLabelText('bad.svg')).toBeInTheDocument();
  });

  it('renders non-image attachments inline with a file icon', () => {
    render(
      <SessionImageAttachmentTray
        attachments={[
          attachment({
            id: 'text',
            file: new File(['notes'], 'notes.md', { type: 'text/markdown' }),
            previewUrl: undefined,
          }),
        ]}
        destination="branch"
        onDestinationChange={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Preview notes.md' })).toBeInTheDocument();
    expect(screen.getByLabelText('notes.md')).toBeInTheDocument();
  });

  it('locks remove and batch settings while composer files are uploading', () => {
    const onRemove = vi.fn();
    const onDestinationChange = vi.fn();

    render(
      <SessionImageAttachmentTray
        attachments={[attachment({ status: 'uploading' })]}
        destination="branch"
        disabled
        onDestinationChange={onDestinationChange}
        onRemove={onRemove}
      />
    );

    expect(
      screen.getByText('Files are uploading. Attachment changes are locked until upload finishes.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Remove chart.png')).toBeDisabled();
    expect(screen.getByLabelText('Batch attachment settings')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Remove chart.png'));
    expect(onRemove).not.toHaveBeenCalled();
    expect(onDestinationChange).not.toHaveBeenCalled();
  });
});
