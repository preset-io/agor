import { describe, expect, it, vi } from 'vitest';
import { deliverInitialSessionContent } from './sessionCreation';

describe('deliverInitialSessionContent', () => {
  it('keeps the full draft retryable and sends nothing when attachment upload fails', async () => {
    const file = new File(['image'], 'shot.png', { type: 'image/png' });
    const sendPrompt = vi.fn();
    const error = new Error('upload failed');
    const onAttachmentUploadError = vi.fn();

    const result = await deliverInitialSessionContent(
      'session-1',
      { prompt: 'inspect this', attachmentFiles: [file] },
      {
        uploadAttachments: vi.fn().mockRejectedValue(error),
        sendPrompt,
        onAttachmentUploadError,
      }
    );

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(onAttachmentUploadError).toHaveBeenCalledWith(error);
    expect(result).toEqual({
      prompt: 'pending',
      attachments: 'failed',
      retry: { prompt: 'inspect this', attachmentFiles: [file] },
    });
  });

  it('retries an already-uploaded attachment message without uploading it again', async () => {
    const file = new File(['image'], 'shot.png', { type: 'image/png' });
    const firstSend = vi.fn().mockResolvedValue(false);
    const first = await deliverInitialSessionContent(
      'session-1',
      { prompt: 'inspect this', attachmentFiles: [file] },
      {
        uploadAttachments: vi.fn().mockResolvedValue('inspect this\n\n[shot](files/shot.png)'),
        sendPrompt: firstSend,
      }
    );

    expect(first.retry).toEqual({ prompt: 'inspect this\n\n[shot](files/shot.png)' });
    const retryUpload = vi.fn();
    const retrySend = vi.fn().mockResolvedValue(true);
    const retried = await deliverInitialSessionContent('session-1', first.retry!, {
      uploadAttachments: retryUpload,
      sendPrompt: retrySend,
    });

    expect(retryUpload).not.toHaveBeenCalled();
    expect(retrySend).toHaveBeenCalledWith(
      'session-1',
      'inspect this\n\n[shot](files/shot.png)',
      undefined
    );
    expect(retried.retry).toBeUndefined();
  });
});
