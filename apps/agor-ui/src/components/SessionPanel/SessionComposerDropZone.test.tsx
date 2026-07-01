import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionComposerDropZone } from './SessionComposerDropZone';

function withFiles(files: File[]) {
  return {
    dataTransfer: {
      files,
      types: ['Files'],
    },
  };
}

describe('SessionComposerDropZone', () => {
  it('routes image drops from the larger composer container to composer attachment handling', () => {
    const onFilesDrop = vi.fn();
    const imageFile = new File(['image'], 'chart.png', { type: 'image/png' });

    render(
      <SessionComposerDropZone onFilesDrop={onFilesDrop}>
        <div>Thumbnail and input area</div>
      </SessionComposerDropZone>
    );

    const dropZone = screen.getByLabelText('Composer attachments and input drop zone');
    const dropEvent = createEvent.drop(dropZone, withFiles([imageFile]));

    fireEvent(dropZone, dropEvent);

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(onFilesDrop).toHaveBeenCalledTimes(1);
    expect(onFilesDrop).toHaveBeenCalledWith([imageFile]);
  });

  it('routes non-image drops from the larger composer container through the same file router', () => {
    const onFilesDrop = vi.fn();
    const textFile = new File(['notes'], 'notes.txt', { type: 'text/plain' });

    render(
      <SessionComposerDropZone onFilesDrop={onFilesDrop}>
        <div>Thumbnail and input area</div>
      </SessionComposerDropZone>
    );

    fireEvent.drop(
      screen.getByLabelText('Composer attachments and input drop zone'),
      withFiles([textFile])
    );

    expect(onFilesDrop).toHaveBeenCalledWith([textFile]);
  });

  it('shows a container-level visual affordance during file drag-over', () => {
    const onDragActiveChange = vi.fn();
    render(
      <SessionComposerDropZone onDragActiveChange={onDragActiveChange} onFilesDrop={vi.fn()}>
        <div>Thumbnail and input area</div>
      </SessionComposerDropZone>
    );

    fireEvent.dragOver(
      screen.getByLabelText('Composer attachments and input drop zone'),
      withFiles([new File(['image'], 'chart.png', { type: 'image/png' })])
    );

    expect(screen.getByText('Drop files here to attach')).toBeInTheDocument();
    expect(onDragActiveChange).toHaveBeenLastCalledWith(true);
  });

  it('does not duplicate drops that are already handled by a child textarea area', () => {
    const onFilesDrop = vi.fn();
    const imageFile = new File(['image'], 'chart.png', { type: 'image/png' });

    render(
      <SessionComposerDropZone onFilesDrop={onFilesDrop}>
        <div data-testid="child-drop-target" onDrop={(event) => event.preventDefault()}>
          Textarea drop target
        </div>
      </SessionComposerDropZone>
    );

    fireEvent.drop(screen.getByTestId('child-drop-target'), withFiles([imageFile]));

    expect(onFilesDrop).not.toHaveBeenCalled();
  });

  it('clears the container drag affordance when a child handles the drop', () => {
    const imageFile = new File(['image'], 'chart.png', { type: 'image/png' });

    render(
      <SessionComposerDropZone onFilesDrop={vi.fn()}>
        <div
          data-testid="child-drop-target"
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          Textarea drop target
        </div>
      </SessionComposerDropZone>
    );

    const dropZone = screen.getByLabelText('Composer attachments and input drop zone');
    fireEvent.dragOver(dropZone, withFiles([imageFile]));
    expect(screen.getByText('Drop files here to attach')).toBeInTheDocument();

    fireEvent.drop(screen.getByTestId('child-drop-target'), withFiles([imageFile]));

    expect(screen.queryByText('Drop files here to attach')).not.toBeInTheDocument();
  });

  it('semantically disables and ignores container drops while uploads are locked', () => {
    const onFilesDrop = vi.fn();
    const imageFile = new File(['image'], 'chart.png', { type: 'image/png' });

    render(
      <SessionComposerDropZone disabled onFilesDrop={onFilesDrop}>
        <div>Thumbnail and input area</div>
      </SessionComposerDropZone>
    );

    const dropZone = screen.getByLabelText('Composer attachments and input drop zone');
    const dropEvent = createEvent.drop(dropZone, withFiles([imageFile]));

    fireEvent(dropZone, dropEvent);

    expect(dropZone).toHaveAttribute('aria-disabled', 'true');
    expect(dropEvent.defaultPrevented).toBe(true);
    expect(onFilesDrop).not.toHaveBeenCalled();
  });
});
