import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionUploadControls } from './SessionUploadControls';

describe('SessionUploadControls', () => {
  it('keeps composer-native file attach and advanced upload entrypoints reachable', () => {
    const onAttachFiles = vi.fn();
    const onOpenAdvancedUpload = vi.fn();

    render(
      <SessionUploadControls
        connectionDisabled={false}
        composerAttachmentUploading={false}
        onAttachFiles={onAttachFiles}
        onOpenAdvancedUpload={onOpenAdvancedUpload}
      />
    );

    fireEvent.click(screen.getByTitle('Attach files'));
    expect(onAttachFiles).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Advanced upload' }));
    expect(onOpenAdvancedUpload).toHaveBeenCalledTimes(1);
  });

  it('disables both upload entrypoints while composer attachments are uploading', () => {
    render(
      <SessionUploadControls
        connectionDisabled={false}
        composerAttachmentUploading
        onAttachFiles={vi.fn()}
        onOpenAdvancedUpload={vi.fn()}
      />
    );

    expect(screen.getByTitle('Attach files')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Advanced upload' })).toBeDisabled();
  });

  it('says the connection to Agor is lost, never "daemon", while disconnected', async () => {
    render(
      <SessionUploadControls
        connectionDisabled
        composerAttachmentUploading={false}
        onAttachFiles={vi.fn()}
        onOpenAdvancedUpload={vi.fn()}
      />
    );

    const advanced = screen.getByRole('button', { name: 'Advanced upload' });
    expect(advanced).toBeDisabled();
    const trigger = advanced.closest('span') ?? advanced;
    fireEvent.pointerEnter(trigger);
    fireEvent.mouseEnter(trigger);
    fireEvent.mouseOver(trigger);
    expect(await screen.findByText('Lost connection to Agor.')).toBeInTheDocument();
    expect(screen.queryByText(/daemon/)).toBeNull();
  });
});
