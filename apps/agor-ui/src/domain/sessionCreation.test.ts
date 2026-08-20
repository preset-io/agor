import { describe, expect, it, vi } from 'vitest';
import { deliverInitialSessionContent, initializeCreatedSession } from './sessionCreation';

const IDEMPOTENCY_KEY = '0198cdef-1234-7000-8000-123456789abc';

describe('deliverInitialSessionContent', () => {
  it('keeps the full draft retryable and sends nothing when attachment upload fails', async () => {
    const file = new File(['image'], 'shot.png', { type: 'image/png' });
    const sendPrompt = vi.fn();
    const error = new Error('upload failed');
    const onAttachmentUploadError = vi.fn();

    const result = await deliverInitialSessionContent(
      'session-1',
      { prompt: 'inspect this', attachmentFiles: [file], idempotencyKey: IDEMPOTENCY_KEY },
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
      retry: {
        prompt: 'inspect this',
        attachmentFiles: [file],
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    });
  });

  it('retries an already-uploaded attachment message without uploading it again', async () => {
    const file = new File(['image'], 'shot.png', { type: 'image/png' });
    const firstSend = vi.fn().mockResolvedValue(false);
    const first = await deliverInitialSessionContent(
      'session-1',
      { prompt: 'inspect this', attachmentFiles: [file], idempotencyKey: IDEMPOTENCY_KEY },
      {
        uploadAttachments: vi.fn().mockResolvedValue('inspect this\n\n[shot](files/shot.png)'),
        sendPrompt: firstSend,
      }
    );

    expect(first.retry).toEqual({
      prompt: 'inspect this\n\n[shot](files/shot.png)',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
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
      undefined,
      IDEMPOTENCY_KEY
    );
    expect(retried.retry).toBeUndefined();
  });

  it('reuses the same prompt admission key after an ambiguous transport failure', async () => {
    const sendPrompt = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const content = { prompt: 'run this', idempotencyKey: IDEMPOTENCY_KEY };
    const dependencies = { uploadAttachments: vi.fn(), sendPrompt };

    const first = await deliverInitialSessionContent('session-1', content, dependencies);
    await deliverInitialSessionContent('session-1', first.retry!, dependencies);

    expect(sendPrompt).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'run this',
      undefined,
      IDEMPOTENCY_KEY
    );
    expect(sendPrompt).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'run this',
      undefined,
      IDEMPOTENCY_KEY
    );
  });
});

describe('initializeCreatedSession', () => {
  const content = { prompt: 'start', idempotencyKey: IDEMPOTENCY_KEY };

  it('blocks prompt admission and retries only failed MCP associations', async () => {
    const associateMcpServer = vi.fn(async (_sessionId: string, serverId: string) => {
      if (serverId === 'mcp-b') throw new Error('not connected');
    });
    const sendPrompt = vi.fn();
    const result = await initializeCreatedSession(
      'session-1',
      { mcpServerIds: ['mcp-a', 'mcp-b'], envVarNames: ['TOKEN'], content },
      {
        associateMcpServer,
        updateEnvironmentVariables: vi.fn(),
        uploadAttachments: vi.fn(),
        sendPrompt,
      }
    );

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sessionId: 'session-1',
      setup: { mcpServers: 'failed', environmentVariables: 'pending' },
      delivery: { prompt: 'pending', attachments: 'not-requested' },
      retry: { mcpServerIds: ['mcp-b'], envVarNames: ['TOKEN'], content },
    });
  });

  it('retains the session and content when environment setup fails', async () => {
    const sendPrompt = vi.fn();
    const result = await initializeCreatedSession(
      'session-1',
      { envVarNames: ['TOKEN'], content },
      {
        associateMcpServer: vi.fn(),
        updateEnvironmentVariables: vi.fn().mockRejectedValue(new Error('env failed')),
        uploadAttachments: vi.fn(),
        sendPrompt,
      }
    );

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sessionId: 'session-1',
      setup: { mcpServers: 'not-requested', environmentVariables: 'failed' },
      retry: { envVarNames: ['TOKEN'], content },
    });
  });
});
