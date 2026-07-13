import { describe, expect, it } from 'vitest';
import {
  isBlockingComposerAttachment,
  isPreviewableComposerImage,
  summarizeComposerFileRejections,
  validateComposerFileIntake,
} from './composerAttachments';

describe('composerAttachments', () => {
  it('matches the server image allowlist used by composer-native attachments', () => {
    expect(isPreviewableComposerImage(new File(['x'], 'chart.png', { type: 'image/png' }))).toBe(
      true
    );
    expect(
      isPreviewableComposerImage(new File(['x'], 'chart.svg', { type: 'image/svg+xml' }))
    ).toBe(false);
  });

  it('accepts arbitrary file types while keeping unsafe images out of inline preview', () => {
    const { acceptedFiles, rejections } = validateComposerFileIntake([
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      new File(['x'], 'unsafe.svg', { type: 'image/svg+xml' }),
      new File(['<script>'], 'page.html', { type: 'text/html' }),
    ]);

    expect(acceptedFiles.map((file) => file.name)).toEqual([
      'notes.txt',
      'unsafe.svg',
      'page.html',
    ]);
    expect(rejections).toEqual([]);
    expect(isPreviewableComposerImage(acceptedFiles[1])).toBe(false);
  });

  it('infers preview MIME for known extensions without rejecting unknown files', () => {
    expect(isPreviewableComposerImage(new File(['x'], 'chart.png', { type: '' }))).toBe(true);

    const { acceptedFiles, rejections } = validateComposerFileIntake([
      new File(['x'], 'notes.txt', { type: '' }),
      new File(['x'], 'report.pdf', { type: '' }),
      new File(['<svg />'], 'unsafe.svg', { type: '' }),
    ]);

    expect(rejections).toEqual([]);
    expect(acceptedFiles.map((file) => [file.name, file.type])).toEqual([
      ['notes.txt', 'text/plain'],
      ['report.pdf', 'application/pdf'],
      ['unsafe.svg', ''],
    ]);
  });

  it('preserves a browser-reported MIME type without blocking the upload', () => {
    const { acceptedFiles, rejections } = validateComposerFileIntake([
      new File(['<script>'], 'renamed.txt', { type: 'text/html' }),
    ]);

    expect(acceptedFiles).toHaveLength(1);
    expect(acceptedFiles[0].type).toBe('text/html');
    expect(rejections).toEqual([]);
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
          reason: 'Composer supports up to 10 attachments',
        }),
        expect.objectContaining({
          file: expect.objectContaining({ name: 'note-10.txt' }),
          reason: 'Composer supports up to 10 attachments',
        }),
      ])
    );
  });

  it('applies the file-count cap uniformly across arbitrary file types', () => {
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
      'bad.svg: Composer supports up to 10 attachments (+11 more)'
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
        reason: 'Composer supports up to 10 attachments',
      }),
      expect.objectContaining({
        file: expect.objectContaining({ name: 'incoming-1.txt' }),
        reason: 'Composer supports up to 10 attachments',
      }),
    ]);
  });

  it('counts uploaded retry attachments toward the file cap', () => {
    const currentAttachments = Array.from({ length: 10 }, (_, index) => ({
      id: `uploaded-${index}`,
      file: new File(['x'], `uploaded-${index}.txt`, { type: 'text/plain' }),
      destination: 'branch' as const,
      status: 'uploaded' as const,
      uploadedFile: {
        filename: `uploaded-${index}.txt`,
        path: `.agor/uploads/uploaded-${index}.txt`,
        size: 1,
        mimeType: 'text/plain',
      },
    }));
    const incoming = new File(['x'], 'incoming.txt', { type: 'text/plain' });

    const { acceptedFiles, rejections } = validateComposerFileIntake(
      [incoming],
      currentAttachments
    );

    expect(acceptedFiles).toEqual([]);
    expect(rejections).toEqual([
      expect.objectContaining({
        file: incoming,
        reason: 'Composer supports up to 10 attachments',
      }),
    ]);
  });

  it('counts uploaded retry attachment bytes toward the total-size cap', () => {
    const uploadedFiles = ['uploaded-a.bin', 'uploaded-b.bin'].map((name) => {
      const file = new File(['x'], name, { type: 'application/octet-stream' });
      Object.defineProperty(file, 'size', { value: 50 * 1024 * 1024 });
      return file;
    });
    const incoming = new File(['x'], 'incoming.bin', { type: 'application/octet-stream' });
    Object.defineProperty(incoming, 'size', { value: 1 });

    const { acceptedFiles, rejections } = validateComposerFileIntake(
      [incoming],
      uploadedFiles.map((file, index) => ({
        id: `uploaded-${index}`,
        file,
        destination: 'branch',
        status: 'uploaded' as const,
        uploadedFile: {
          filename: file.name,
          path: `.agor/uploads/${file.name}`,
          size: file.size,
          mimeType: file.type,
        },
      }))
    );

    expect(acceptedFiles).toEqual([]);
    expect(rejections).toEqual([
      expect.objectContaining({
        file: incoming,
        reason: 'Selected files exceed 100 MB total',
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
