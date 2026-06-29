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
});
