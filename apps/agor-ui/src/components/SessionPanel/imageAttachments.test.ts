import { describe, expect, it } from 'vitest';
import {
  buildPromptWithImageAttachments,
  getLatestComposerPromptText,
  isBlockingComposerImageAttachment,
  isSupportedComposerImage,
} from './imageAttachments';

describe('imageAttachments', () => {
  it('builds a hidden file-path preamble without modifying visible text', () => {
    expect(
      buildPromptWithImageAttachments('Compare these charts', [
        '.agor/uploads/chart-a.png',
        '.agor/uploads/chart-b.png',
      ])
    ).toBe(
      'Attached files:\n- .agor/uploads/chart-a.png\n- .agor/uploads/chart-b.png\n\nCompare these charts'
    );
  });

  it('supports attachment-only prompts', () => {
    expect(buildPromptWithImageAttachments('   ', ['.agor/uploads/chart-a.png'])).toBe(
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
    expect(isSupportedComposerImage(new File(['x'], 'chart.png', { type: 'image/png' }))).toBe(
      true
    );
    expect(isSupportedComposerImage(new File(['x'], 'chart.svg', { type: 'image/svg+xml' }))).toBe(
      false
    );
  });

  it('only blocks failed composer attachments from send until removed', () => {
    const png = new File(['x'], 'chart.png', { type: 'image/png' });
    const text = new File(['x'], 'notes.txt', { type: 'text/plain' });

    expect(
      isBlockingComposerImageAttachment({
        id: 'pending-png',
        file: png,
        previewUrl: 'blob:png',
        destination: 'branch',
        status: 'pending',
      })
    ).toBe(false);

    expect(
      isBlockingComposerImageAttachment({
        id: 'failed-png',
        file: png,
        previewUrl: 'blob:png',
        destination: 'branch',
        status: 'failed',
        error: 'Upload failed',
      })
    ).toBe(true);

    expect(
      isBlockingComposerImageAttachment({
        id: 'pending-text',
        file: text,
        destination: 'branch',
        status: 'pending',
      })
    ).toBe(false);
  });
});
