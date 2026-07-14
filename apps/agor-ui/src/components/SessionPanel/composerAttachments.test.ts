import { describe, expect, it } from 'vitest';
import {
  buildPromptWithAttachments,
  getLatestComposerPromptText,
  isBlockingComposerAttachment,
  isPreviewableComposerImage,
  isSupportedComposerUploadFile,
  summarizeComposerFileRejections,
  validateComposerFileIntake,
} from './composerAttachments';

describe('composerAttachments', () => {
  it('builds a hidden file-path preamble without modifying visible text', () => {
    expect(
      buildPromptWithAttachments('Compare these charts', [
        '.agor/uploads/chart-a.png',
        '.agor/uploads/chart-b.png',
      ])
    ).toBe(
      'Attached files:\n- .agor/uploads/chart-a.png\n- .agor/uploads/chart-b.png\n\nCompare these charts'
    );
  });

  it('preserves slash commands at the start of the sent prompt', () => {
    expect(
      buildPromptWithAttachments('/compact focus on this chart', ['.agor/uploads/chart.png'])
    ).toBe(`/compact focus on this chart

Attached files:
- .agor/uploads/chart.png`);
  });

  it('supports attachment-only prompts', () => {
    expect(buildPromptWithAttachments('   ', ['.agor/uploads/chart-a.png'])).toBe(
      'Attached files:\n- .agor/uploads/chart-a.png'
    );
  });

  it('uses the live textarea value for prompt edits typed during attachment upload', () => {
    expect(
      getLatestComposerPromptText({
        promptHandle: { getValue: () => 'send-start text plus upload-time edit' },
        inputValueRefValue: 'send-start text',
        sendStartValue: 'send-start text',
      })
    ).toBe('send-start text plus upload-time edit');
  });

  it('does not resurrect send-start text when the live textarea is cleared during upload', () => {
    expect(
      getLatestComposerPromptText({
        promptHandle: { getValue: () => '' },
        inputValueRefValue: 'send-start text',
        sendStartValue: 'send-start text',
      })
    ).toBe('');
  });

  it('matches the server image allowlist used by composer-native attachments', () => {
    expect(isPreviewableComposerImage(new File(['x'], 'chart.png', { type: 'image/png' }))).toBe(
      true
    );
    expect(
      isPreviewableComposerImage(new File(['x'], 'chart.svg', { type: 'image/svg+xml' }))
    ).toBe(false);
  });

  it('validates composer upload file types before send', () => {
    expect(
      isSupportedComposerUploadFile(new File(['x'], 'notes.txt', { type: 'text/plain' }))
    ).toBe(true);
    expect(
      isSupportedComposerUploadFile(new File(['x'], 'chart.svg', { type: 'image/svg+xml' }))
    ).toBe(false);

    const { acceptedFiles, rejections } = validateComposerFileIntake([
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      new File(['x'], 'unsafe.svg', { type: 'image/svg+xml' }),
    ]);

    expect(acceptedFiles.map((file) => file.name)).toEqual(['notes.txt']);
    expect(rejections).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ name: 'unsafe.svg' }),
        reason: 'Unsupported file type: image/svg+xml',
      }),
    ]);
  });

  it('infers supported file types from safe extensions when dropped files have empty MIME', () => {
    expect(isSupportedComposerUploadFile(new File(['x'], 'notes.txt', { type: '' }))).toBe(true);
    expect(isPreviewableComposerImage(new File(['x'], 'chart.png', { type: '' }))).toBe(true);

    const { acceptedFiles, rejections } = validateComposerFileIntake([
      new File(['x'], 'notes.txt', { type: '' }),
      new File(['x'], 'report.pdf', { type: '' }),
      new File(['<svg />'], 'unsafe.svg', { type: '' }),
    ]);

    expect(rejections).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ name: 'unsafe.svg' }),
        reason: 'Unsupported file type: unknown',
      }),
    ]);
    expect(acceptedFiles.map((file) => [file.name, file.type])).toEqual([
      ['notes.txt', 'text/plain'],
      ['report.pdf', 'application/pdf'],
    ]);
  });

  it('does not trust extensions when the browser reports an unsupported MIME type', () => {
    const { acceptedFiles, rejections } = validateComposerFileIntake([
      new File(['<script>'], 'renamed.txt', { type: 'text/html' }),
    ]);

    expect(acceptedFiles).toHaveLength(0);
    expect(rejections).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ name: 'renamed.txt' }),
        reason: 'Unsupported file type: text/html',
      }),
    ]);
  });

  it('rejects a supported incoming batch that exceeds one backend request batch', () => {
    const files = Array.from(
      { length: 11 },
      (_, index) => new File(['x'], `note-${index}.txt`, { type: 'text/plain' })
    );

    const { acceptedFiles, rejections } = validateComposerFileIntake(files);

    expect(acceptedFiles).toHaveLength(0);
    expect(rejections).toHaveLength(11);
    expect(rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: expect.objectContaining({ name: 'note-0.txt' }),
          reason: 'Composer supports up to 10 pending files',
        }),
        expect.objectContaining({
          file: expect.objectContaining({ name: 'note-10.txt' }),
          reason: 'Composer supports up to 10 pending files',
        }),
      ])
    );
  });

  it('prioritizes the cap message when mixed invalid and supported files exceed the cap', () => {
    const files = [
      new File(['<svg />'], 'bad.svg', { type: 'image/svg+xml' }),
      ...Array.from(
        { length: 11 },
        (_, index) => new File(['x'], `note-${index}.txt`, { type: 'text/plain' })
      ),
    ];

    const { acceptedFiles, rejections } = validateComposerFileIntake(files);

    expect(acceptedFiles).toHaveLength(0);
    expect(rejections).toHaveLength(12);
    expect(summarizeComposerFileRejections(rejections)).toBe(
      'note-0.txt: Composer supports up to 10 pending files (+11 more)'
    );
  });

  it('preserves existing pending files and rejects a new batch that would exceed the cap', () => {
    const currentAttachments = Array.from({ length: 9 }, (_, index) => ({
      id: `current-${index}`,
      file: new File(['x'], `current-${index}.txt`, { type: 'text/plain' }),
      destination: 'branch' as const,
      status: 'pending' as const,
    }));
    const incomingFiles = [
      new File(['x'], 'incoming-0.txt', { type: 'text/plain' }),
      new File(['x'], 'incoming-1.txt', { type: 'text/plain' }),
    ];

    const { acceptedFiles, rejections } = validateComposerFileIntake(
      incomingFiles,
      currentAttachments,
      'branch'
    );

    expect(acceptedFiles).toHaveLength(0);
    expect(rejections).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ name: 'incoming-0.txt' }),
        reason: 'Composer supports up to 10 pending files',
      }),
      expect.objectContaining({
        file: expect.objectContaining({ name: 'incoming-1.txt' }),
        reason: 'Composer supports up to 10 pending files',
      }),
    ]);
  });

  it('only blocks failed composer attachments from send until removed', () => {
    const png = new File(['x'], 'chart.png', { type: 'image/png' });
    const text = new File(['x'], 'notes.txt', { type: 'text/plain' });

    expect(
      isBlockingComposerAttachment({
        id: 'pending-png',
        file: png,
        previewUrl: 'blob:png',
        destination: 'branch',
        status: 'pending',
      })
    ).toBe(false);

    expect(
      isBlockingComposerAttachment({
        id: 'failed-png',
        file: png,
        previewUrl: 'blob:png',
        destination: 'branch',
        status: 'failed',
        error: 'Upload failed',
      })
    ).toBe(true);

    expect(
      isBlockingComposerAttachment({
        id: 'pending-text',
        file: text,
        destination: 'branch',
        status: 'pending',
      })
    ).toBe(false);
  });
});
