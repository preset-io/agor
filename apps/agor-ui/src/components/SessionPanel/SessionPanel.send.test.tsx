import type { AgorClient, Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import type { UploadFilesToSessionResult } from '../FileUpload/upload';
import SessionPanel from './SessionPanel';

const uploadMockState = vi.hoisted(() => ({
  uploadFilesToSession: vi.fn(),
}));

vi.mock('../FileUpload/upload', () => ({
  uploadFilesToSession: uploadMockState.uploadFilesToSession,
}));

vi.mock('./SessionPanelContent', () => ({
  SessionPanelContent: () => null,
}));

vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({ handle: null, state: { tasks: [] } }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'session-1',
    branch_id: 'branch-1',
    agentic_tool: 'codex',
    status: 'completed',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Session;
}

function makeClient(): AgorClient {
  const taskEvents = {
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    service: vi.fn((name: string) => {
      if (name === 'tasks') return taskEvents;
      return { find: vi.fn().mockResolvedValue({ data: [] }) };
    }),
  } as unknown as AgorClient;
}

function renderSessionPanel({
  onSendPrompt = vi.fn(),
  onFork = vi.fn(),
  onBtwFork = vi.fn(),
  session = makeSession(),
  currentUserId = 'user-a',
}: {
  onSendPrompt?: (
    sessionId: string,
    prompt: string
  ) => boolean | undefined | Promise<boolean | undefined>;
  onFork?: (sessionId: string, prompt: string) => Promise<void>;
  onBtwFork?: (sessionId: string, prompt: string) => Promise<void>;
  session?: Session;
  currentUserId?: string;
} = {}) {
  let activeSession = session;
  let activeUserId: string | undefined = currentUserId;
  const renderTree = () => (
    <App>
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <AppActionsProvider value={{ onSendPrompt, onFork, onBtwFork }}>
          <SessionPanel
            client={makeClient()}
            session={activeSession}
            currentUserId={activeUserId}
            open
            onClose={vi.fn()}
          />
        </AppActionsProvider>
      </ConnectionProvider>
    </App>
  );
  const renderResult = render(renderTree());
  return {
    onSendPrompt,
    onFork,
    onBtwFork,
    rerenderSession: (nextSession: Session) => {
      activeSession = nextSession;
      renderResult.rerender(renderTree());
    },
    rerenderUser: (nextUserId?: string) => {
      activeUserId = nextUserId;
      renderResult.rerender(renderTree());
    },
    ...renderResult,
  };
}

describe('SessionPanel composer send', () => {
  beforeEach(() => {
    agorStore.getState().reset();
    uploadMockState.uploadFilesToSession.mockReset();
    localStorage.clear();
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:preview'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    });
  });

  it('sends prompt edits typed while attachment upload is in flight with the upload-start attachments', async () => {
    const upload = deferred<UploadFilesToSessionResult>();
    uploadMockState.uploadFilesToSession.mockReturnValue(upload.promise);
    const onSendPrompt = vi.fn();
    const { container } = renderSessionPanel({ onSendPrompt });

    const dropZone = screen.getByLabelText('Composer attachments and input drop zone');
    const sendStartFile = new File(['image'], 'chart.png', { type: 'image/png' });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [sendStartFile],
      },
    });

    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Compare this chart' } });

    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(sendButton as HTMLButtonElement);

    await waitFor(() => expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1));
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ destination: expect.anything() })
    );
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledWith(
      expect.objectContaining({ files: [sendStartFile], notifyAgent: false })
    );

    fireEvent.change(textarea, { target: { value: 'Compare this chart and mention the anomaly' } });

    upload.resolve({
      success: true,
      files: [
        {
          filename: 'chart.png',
          ref: 'upl_00000000-0000-4000-8000-000000000001',
          size: 5,
          mimeType: 'image/png',
        },
      ],
    });

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Attachments — use `agor_upload_materialize` to access:\n- [chart.png](https://agor.live/_uploads/upl_00000000-0000-4000-8000-000000000001) (image/png, 5 B)\n\nCompare this chart and mention the anomaly',
      expect.any(String)
    );
  });

  it('does not mix or clear the newly selected session composer when upload resolves after session switch', async () => {
    const upload = deferred<UploadFilesToSessionResult>();
    uploadMockState.uploadFilesToSession.mockReturnValue(upload.promise);
    const onSendPrompt = vi.fn();
    const { container, rerenderSession } = renderSessionPanel({ onSendPrompt });

    const dropZone = screen.getByLabelText('Composer attachments and input drop zone');
    const sendStartFile = new File(['old image'], 'old-session-chart.png', {
      type: 'image/png',
    });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [sendStartFile],
      },
    });

    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Old session prompt snapshot' } });

    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(sendButton as HTMLButtonElement);

    await waitFor(() => expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1));
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', files: [sendStartFile] })
    );

    rerenderSession(makeSession({ session_id: 'session-2' }));
    const nextTextarea = screen.getByPlaceholderText(/Prompt here/i);
    await waitFor(() => expect(nextTextarea).toHaveValue(''));
    fireEvent.change(nextTextarea, { target: { value: 'New session prompt must stay local' } });

    upload.resolve({
      success: true,
      files: [
        {
          filename: 'old-session-chart.png',
          ref: 'upl_00000000-0000-4000-8000-000000000002',
          size: 9,
          mimeType: 'image/png',
        },
      ],
    });

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Attachments — use `agor_upload_materialize` to access:\n- [old-session-chart.png](https://agor.live/_uploads/upl_00000000-0000-4000-8000-000000000002) (image/png, 9 B)\n\nOld session prompt snapshot',
      expect.any(String)
    );
    expect(onSendPrompt).not.toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('New session prompt must stay local'),
      expect.any(String)
    );
    expect(nextTextarea).toHaveValue('New session prompt must stay local');
  });

  it('isolates the visible composer when the authenticated user changes on the same session', async () => {
    const { rerenderUser } = renderSessionPanel();
    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'User A private draft' } });

    await new Promise((resolve) => setTimeout(resolve, 350));
    rerenderUser('user-b');

    await waitFor(() => expect(screen.getByPlaceholderText(/Prompt here/i)).toHaveValue(''));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(localStorage.getItem('agor:prompt-draft')).toContain('"ownerId":"user-a"');
    expect(localStorage.getItem('agor:prompt-draft')).not.toContain('user-b');
  });

  it('does not clear a replacement composer after an old identity send completes', async () => {
    const send = deferred<boolean>();
    const onSendPrompt = vi.fn().mockReturnValue(send.promise);
    const { container, rerenderUser } = renderSessionPanel({ onSendPrompt });

    fireEvent.change(screen.getByPlaceholderText(/Prompt here/i), {
      target: { value: 'User A prompt' },
    });
    fireEvent.click(container.querySelector('button.ant-btn-primary') as HTMLButtonElement);
    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));

    rerenderUser(undefined);
    rerenderUser('user-a');
    const replacement = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(replacement, { target: { value: 'Same user, new login draft' } });
    send.resolve(true);

    await waitFor(() => expect(replacement).toHaveValue('Same user, new login draft'));
  });

  it("does not clear a later caller's identical text or attachments after admission", async () => {
    const send = deferred<boolean>();
    const onSendPrompt = vi.fn().mockReturnValue(send.promise);
    const { container, rerenderUser } = renderSessionPanel({ onSendPrompt });

    fireEvent.change(screen.getByPlaceholderText(/Prompt here/i), {
      target: { value: 'Identical prompt' },
    });
    fireEvent.click(container.querySelector('button.ant-btn-primary') as HTMLButtonElement);
    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));

    rerenderUser('user-b');
    const replacement = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(replacement, { target: { value: 'Identical prompt' } });
    fireEvent.drop(screen.getByLabelText('Composer attachments and input drop zone'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['later caller'], 'user-b.txt', { type: 'text/plain' })],
      },
    });
    await waitFor(() => expect(screen.getByLabelText('Preview user-b.txt')).toBeInTheDocument());

    send.resolve(true);

    await waitFor(() => expect(replacement).toHaveValue('Identical prompt'));
    expect(screen.getByLabelText('Preview user-b.txt')).toBeInTheDocument();
  });

  it('ignores a rapid second send while the first attachment upload is still in flight', async () => {
    const upload = deferred<UploadFilesToSessionResult>();
    const onSendPrompt = vi.fn();
    const { container } = renderSessionPanel({ onSendPrompt });

    const dropZone = screen.getByLabelText('Composer attachments and input drop zone');
    const file = new File(['rapid image'], 'rapid-chart.png', { type: 'image/png' });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [file],
      },
    });

    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Summarize this rapid chart' } });

    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);

    let attemptedSecondSend = false;
    uploadMockState.uploadFilesToSession.mockImplementation(() => {
      if (!attemptedSecondSend) {
        attemptedSecondSend = true;
        fireEvent.click(sendButton as HTMLButtonElement);
      }
      return upload.promise;
    });

    fireEvent.click(sendButton as HTMLButtonElement);

    await waitFor(() => expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1));
    expect(attemptedSecondSend).toBe(true);
    expect(onSendPrompt).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('Summarize this rapid chart');
    expect(screen.getByLabelText('Preview rapid-chart.png')).toBeInTheDocument();

    upload.resolve({
      success: true,
      files: [
        {
          filename: 'rapid-chart.png',
          ref: 'upl_00000000-0000-4000-8000-000000000003',
          size: 11,
          mimeType: 'image/png',
        },
      ],
    });

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Attachments — use `agor_upload_materialize` to access:\n- [rapid-chart.png](https://agor.live/_uploads/upl_00000000-0000-4000-8000-000000000003) (image/png, 11 B)\n\nSummarize this rapid chart',
      expect.any(String)
    );
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ destination: expect.anything() })
    );
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledWith(
      expect.objectContaining({ files: [file], notifyAgent: false })
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(screen.queryByLabelText('Preview rapid-chart.png')).not.toBeInTheDocument();
  });

  it('disables footer send and upload actions while composer attachments upload', async () => {
    localStorage.setItem('agor-footer-prefs', JSON.stringify({ pinnedItems: ['upload'] }));
    const upload = deferred<UploadFilesToSessionResult>();
    uploadMockState.uploadFilesToSession.mockReturnValue(upload.promise);
    const onSendPrompt = vi.fn();
    const { container } = renderSessionPanel({ onSendPrompt });

    const dropZone = screen.getByLabelText('Composer attachments and input drop zone');
    const file = new File(['chart'], 'uploading-chart.png', { type: 'image/png' });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [file],
      },
    });

    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Summarize this while upload locks actions' } });

    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(sendButton as HTMLButtonElement);

    await waitFor(() => expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(sendButton).toBeDisabled();
      expect(screen.getByTestId('upload-bar-btn')).toBeDisabled();
    });

    upload.resolve({
      success: true,
      files: [
        {
          filename: 'uploading-chart.png',
          ref: 'upl_00000000-0000-4000-8000-000000000004',
          size: 5,
          mimeType: 'image/png',
        },
      ],
    });

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
  });

  it('keeps an upload failure visible and preserves its reason on repeated send', async () => {
    const reason = 'A file exceeds the upload size limit (reference: request-123)';
    uploadMockState.uploadFilesToSession.mockRejectedValue(new Error(reason));
    const onSendPrompt = vi.fn();
    const { container } = renderSessionPanel({ onSendPrompt });
    fireEvent.drop(screen.getByLabelText('Composer attachments and input drop zone'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['image'], 'chart.png', { type: 'image/png' })],
      },
    });
    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Describe this chart' } });
    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(sendButton as HTMLButtonElement);

    expect(await screen.findByText(`chart.png: ${reason}`)).toBeVisible();
    fireEvent.click(sendButton as HTMLButtonElement);
    expect(
      await screen.findByText(`chart.png: ${reason}. Remove failed files before sending.`)
    ).toBeVisible();
    expect(uploadMockState.uploadFilesToSession).toHaveBeenCalledTimes(1);
    expect(onSendPrompt).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('Describe this chart');
  });

  it('preserves prompt and uploaded attachments when prompt submission fails after upload', async () => {
    uploadMockState.uploadFilesToSession.mockResolvedValue({
      success: true,
      files: [
        {
          filename: 'preserve-chart.png',
          ref: 'upl_00000000-0000-4000-8000-000000000005',
          size: 12,
          mimeType: 'image/png',
        },
      ],
    });
    const onSendPrompt = vi.fn().mockResolvedValue(false);
    const { container } = renderSessionPanel({ onSendPrompt });

    const dropZone = screen.getByLabelText('Composer attachments and input drop zone');
    const file = new File(['preserve image'], 'preserve-chart.png', { type: 'image/png' });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [file],
      },
    });

    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Keep this prompt if submit fails' } });

    const sendButton = container.querySelector('button.ant-btn-primary');
    expect(sendButton).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(sendButton as HTMLButtonElement);

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Attachments — use `agor_upload_materialize` to access:\n- [preserve-chart.png](https://agor.live/_uploads/upl_00000000-0000-4000-8000-000000000005) (image/png, 12 B)\n\nKeep this prompt if submit fails',
      expect.any(String)
    );
    expect(textarea).toHaveValue('Keep this prompt if submit fails');
    expect(screen.getByLabelText('Preview preserve-chart.png')).toBeInTheDocument();
  });

  it('disables fork, spawn, and BTW while composer attachments are present', async () => {
    localStorage.setItem(
      'agor-footer-prefs',
      JSON.stringify({ pinnedItems: ['fork', 'spawn', 'btw-fork'] })
    );
    const onFork = vi.fn().mockResolvedValue(undefined);
    const onBtwFork = vi.fn().mockResolvedValue(undefined);
    renderSessionPanel({ onFork, onBtwFork });

    fireEvent.drop(screen.getByLabelText('Composer attachments and input drop zone'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
      },
    });

    const forkButton = screen.getByLabelText('Fork session');
    const spawnButton = screen.getByLabelText('Spawn subsession');
    const btwButton = screen.getByLabelText('Ask side question via BTW fork');
    expect(forkButton).toBeDisabled();
    expect(spawnButton).toBeDisabled();
    expect(btwButton).toBeDisabled();

    fireEvent.click(forkButton);
    fireEvent.click(spawnButton);
    fireEvent.click(btwButton);
    expect(onFork).not.toHaveBeenCalled();
    expect(onBtwFork).not.toHaveBeenCalled();
  });

  it('shows unsupported file intake errors before upload/send', async () => {
    const onSendPrompt = vi.fn();
    renderSessionPanel({ onSendPrompt });

    fireEvent.drop(screen.getByLabelText('Composer attachments and input drop zone'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['<script>'], 'unsafe.html', { type: 'text/html' })],
      },
    });

    await waitFor(() => {
      expect(
        screen.getAllByText(/unsafe.html: Unsupported file type: text\/html/).length
      ).toBeGreaterThan(0);
    });

    expect(uploadMockState.uploadFilesToSession).not.toHaveBeenCalled();
    expect(onSendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Preview unsafe.html')).not.toBeInTheDocument();
  });

  it('shows a visible cap error and rejects an incoming batch over 10 files', async () => {
    const onSendPrompt = vi.fn();
    renderSessionPanel({ onSendPrompt });

    const files = Array.from(
      { length: 11 },
      (_, index) =>
        new File(['x'], `pending-${String(index).padStart(2, '0')}.txt`, { type: 'text/plain' })
    );
    fireEvent.drop(screen.getByLabelText('Composer attachments and input drop zone'), {
      dataTransfer: {
        types: ['Files'],
        files,
      },
    });

    await waitFor(() => {
      expect(
        screen.getAllByText(
          /pending-00.txt: Composer supports up to 10 pending files \(\+10 more\)/
        ).length
      ).toBeGreaterThan(0);
    });

    expect(screen.queryByLabelText('Preview pending-00.txt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview pending-09.txt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview pending-10.txt')).not.toBeInTheDocument();
    expect(uploadMockState.uploadFilesToSession).not.toHaveBeenCalled();
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  it('prioritizes the visible cap error for mixed invalid and over-cap batches', async () => {
    const onSendPrompt = vi.fn();
    renderSessionPanel({ onSendPrompt });

    const files = [
      new File(['<svg />'], 'bad.svg', { type: 'image/svg+xml' }),
      ...Array.from(
        { length: 11 },
        (_, index) =>
          new File(['x'], `pending-${String(index).padStart(2, '0')}.txt`, {
            type: 'text/plain',
          })
      ),
    ];
    fireEvent.drop(screen.getByLabelText('Composer attachments and input drop zone'), {
      dataTransfer: {
        types: ['Files'],
        files,
      },
    });

    await waitFor(() => {
      expect(
        screen.getAllByText(
          /pending-00.txt: Composer supports up to 10 pending files \(\+11 more\)/
        ).length
      ).toBeGreaterThan(0);
    });

    expect(screen.queryByText(/bad.svg: Unsupported file type/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview pending-00.txt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview pending-10.txt')).not.toBeInTheDocument();
    expect(uploadMockState.uploadFilesToSession).not.toHaveBeenCalled();
    expect(onSendPrompt).not.toHaveBeenCalled();
  });
});
