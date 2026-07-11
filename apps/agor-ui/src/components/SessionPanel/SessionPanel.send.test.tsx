import type { AgorClient, Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import type { UploadFilesToSessionResult } from '../FileUpload/upload';
import SessionPanel from './SessionPanel';

const uploadMockState = vi.hoisted(() => ({
  uploadFilesToSession: vi.fn(),
}));
const footerMockState = vi.hoisted(() => ({ lightweight: false }));

vi.mock('../FileUpload/upload', () => ({
  uploadFilesToSession: uploadMockState.uploadFilesToSession,
}));

vi.mock('../FileUpload', () => ({
  FileUpload: ({
    open,
    onInsertMention,
  }: {
    open: boolean;
    onInsertMention: (filepath: string) => void;
  }) =>
    open ? (
      <button type="button" onClick={() => onInsertMention('.agor/uploads/advanced.txt')}>
        Insert uploaded mention
      </button>
    ) : null,
  FileUploadButton: ({
    onClick,
    disabled,
    title,
  }: {
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} title={title}>
      {title}
    </button>
  ),
}));

vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({
  ForkSpawnModal: ({
    open,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    onConfirm: (prompt: string) => Promise<unknown>;
    onCancel: () => void;
  }) =>
    open ? (
      <button
        type="button"
        onClick={async () => {
          if ((await onConfirm('Fork from modal')) !== false) onCancel();
        }}
      >
        Confirm fork modal
      </button>
    ) : null,
}));

vi.mock('./SessionFooter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SessionFooter')>();
  const ActualSessionFooter = actual.SessionFooter;
  return {
    ...actual,
    SessionFooter: (props: React.ComponentProps<typeof ActualSessionFooter>) =>
      footerMockState.lightweight ? (
        <div>
          {props.promptInputSlot}
          <button type="button" aria-label="Fork session" onClick={props.onFork}>
            Fork
          </button>
          <button type="button" aria-label="Spawn subsession" onClick={props.onSpawnOpen}>
            Spawn
          </button>
        </div>
      ) : (
        <ActualSessionFooter {...props} />
      ),
  };
});

vi.mock('./SessionPanelContent', () => ({
  SessionPanelContent: ({
    spawnModalOpen,
    onSpawnModalConfirm,
    inputValueRef,
  }: {
    spawnModalOpen: boolean;
    onSpawnModalConfirm: (config: string) => Promise<unknown>;
    inputValueRef: React.RefObject<string>;
  }) =>
    spawnModalOpen ? (
      <button type="button" onClick={() => void onSpawnModalConfirm(inputValueRef.current ?? '')}>
        Confirm spawn
      </button>
    ) : null,
}));

vi.mock('./SessionAttachmentsDropdown', () => ({
  SessionAttachmentsDropdown: () => null,
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
  client = makeClient(),
}: {
  onSendPrompt?: (
    sessionId: string,
    prompt: string
  ) => boolean | undefined | Promise<boolean | undefined>;
  onFork?: (sessionId: string, prompt: string) => Promise<void>;
  onBtwFork?: (sessionId: string, prompt: string) => Promise<void>;
  session?: Session;
  client?: AgorClient;
} = {}) {
  const renderTree = (nextSession: Session) => (
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
          <SessionPanel client={client} session={nextSession} open onClose={vi.fn()} />
        </AppActionsProvider>
      </ConnectionProvider>
    </App>
  );
  const renderResult = render(renderTree(session));
  return {
    onSendPrompt,
    onFork,
    onBtwFork,
    rerenderSession: (nextSession: Session) => renderResult.rerender(renderTree(nextSession)),
    ...renderResult,
  };
}

describe('SessionPanel composer send', () => {
  beforeEach(() => {
    footerMockState.lightweight = false;
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

  it('locks composer mutations until attachment upload and prompt submission settle', async () => {
    localStorage.setItem('agor-footer-prefs', JSON.stringify({ pinnedItems: ['upload'] }));
    const submission = deferred<boolean>();
    uploadMockState.uploadFilesToSession.mockResolvedValue({
      success: true,
      files: [
        {
          filename: 'chart.png',
          path: '.agor/uploads/chart.png',
          size: 5,
          mimeType: 'image/png',
          linkId: 'upload-link-1',
        },
      ],
    });
    const onSendPrompt = vi.fn().mockReturnValue(submission.promise);
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

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Attached files:\n- .agor/uploads/chart.png\n\nCompare this chart',
      expect.any(String),
      ['upload-link-1']
    );
    expect(textarea).toBeDisabled();
    expect(dropZone).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('Remove chart.png')).toBeDisabled();
    expect(screen.getByTestId('upload-bar-btn')).toBeDisabled();
    expect(container.querySelector('input[type="file"]')).toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'This must not replace the submitted prompt' } });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['later'], 'later.txt', { type: 'text/plain' })],
      },
    });
    fireEvent.click(screen.getByLabelText('Remove chart.png'));
    expect(textarea).toHaveValue('Compare this chart');
    expect(screen.queryByLabelText('Preview later.txt')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Preview chart.png')).toBeInTheDocument();

    submission.resolve(true);

    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea).toHaveValue('');
    expect(dropZone).toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByLabelText('Preview chart.png')).not.toBeInTheDocument();
    expect(screen.getByTestId('upload-bar-btn')).not.toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'Next prompt' } });
    expect(textarea).toHaveValue('Next prompt');
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
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(textarea).toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'New session prompt must stay local' } });
    expect(textarea).toHaveValue('');

    upload.resolve({
      success: true,
      files: [
        {
          filename: 'old-session-chart.png',
          path: '.agor/uploads/old-session-chart.png',
          size: 9,
          mimeType: 'image/png',
        },
      ],
    });

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Attached files:\n- .agor/uploads/old-session-chart.png\n\nOld session prompt snapshot',
      expect.any(String)
    );
    expect(onSendPrompt).not.toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('New session prompt must stay local'),
      expect.any(String)
    );
    await waitFor(() => expect(textarea).not.toBeDisabled());
    fireEvent.change(textarea, { target: { value: 'New session prompt must stay local' } });
    expect(textarea).toHaveValue('New session prompt must stay local');
  });

  it('rechecks composer ownership after a deferred prompt submission settles', async () => {
    const submission = deferred<boolean>();
    const onSendPrompt = vi.fn().mockReturnValue(submission.promise);
    localStorage.setItem('agor-draft-session-2', 'New session draft');
    const { container, rerenderSession } = renderSessionPanel({ onSendPrompt });

    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Original session prompt' } });
    fireEvent.click(container.querySelector('button.ant-btn-primary') as HTMLButtonElement);
    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));

    rerenderSession(makeSession({ session_id: 'session-2' }));
    await waitFor(() => expect(textarea).toHaveValue('New session draft'));
    expect(textarea).toBeDisabled();

    submission.resolve(true);

    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea).toHaveValue('New session draft');
    expect(localStorage.getItem('agor-draft-session-1')).toBeNull();
    expect(localStorage.getItem('agor-draft-session-2')).toBe('New session draft');
  });

  it('rechecks composer ownership after the uploaded-link refresh settles', async () => {
    const linkRefresh = deferred<never[]>();
    const findAll = vi
      .fn()
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(linkRefresh.promise);
    const taskEvents = { on: vi.fn(), off: vi.fn() };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'tasks') return taskEvents;
        if (name === 'links') return { findAll };
        return { find: vi.fn().mockResolvedValue({ data: [] }) };
      }),
    } as unknown as AgorClient;
    uploadMockState.uploadFilesToSession.mockResolvedValue({
      success: true,
      files: [
        {
          filename: 'refresh.png',
          path: '.agor/uploads/refresh.png',
          size: 7,
          mimeType: 'image/png',
          linkId: 'refresh-link',
        },
      ],
    });
    localStorage.setItem('agor-draft-session-2', 'New session draft');
    const { container, rerenderSession } = renderSessionPanel({ client });
    await waitFor(() => expect(findAll).toHaveBeenCalledTimes(1));

    fireEvent.drop(screen.getByLabelText('Composer attachments and input drop zone'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['image'], 'refresh.png', { type: 'image/png' })],
      },
    });
    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Original session prompt' } });
    fireEvent.click(container.querySelector('button.ant-btn-primary') as HTMLButtonElement);
    await waitFor(() => expect(findAll).toHaveBeenCalledTimes(2));

    rerenderSession(makeSession({ session_id: 'session-2' }));
    await waitFor(() => expect(textarea).toHaveValue('New session draft'));
    expect(textarea).toBeDisabled();

    linkRefresh.resolve([]);

    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea).toHaveValue('New session draft');
    expect(localStorage.getItem('agor-draft-session-1')).toBeNull();
    expect(localStorage.getItem('agor-draft-session-2')).toBe('New session draft');
  });

  it('does not start an old-session link refresh after deferred prompt submission switches sessions', async () => {
    const submission = deferred<boolean>();
    const findAll = vi.fn().mockResolvedValue([]);
    const taskEvents = { on: vi.fn(), off: vi.fn() };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'tasks') return taskEvents;
        if (name === 'links') return { findAll };
        return { find: vi.fn().mockResolvedValue({ data: [] }) };
      }),
    } as unknown as AgorClient;
    uploadMockState.uploadFilesToSession.mockResolvedValue({
      success: true,
      files: [
        {
          filename: 'deferred.png',
          path: '.agor/uploads/deferred.png',
          size: 7,
          mimeType: 'image/png',
          linkId: 'deferred-link',
        },
      ],
    });
    const onSendPrompt = vi.fn().mockReturnValue(submission.promise);
    localStorage.setItem('agor-draft-session-2', 'New session draft');
    const { container, rerenderSession } = renderSessionPanel({ client, onSendPrompt });
    await waitFor(() => expect(findAll).toHaveBeenCalledTimes(1));

    fireEvent.drop(screen.getByLabelText('Composer attachments and input drop zone'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['image'], 'deferred.png', { type: 'image/png' })],
      },
    });
    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Original session prompt' } });
    fireEvent.click(container.querySelector('button.ant-btn-primary') as HTMLButtonElement);
    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));

    rerenderSession(makeSession({ session_id: 'session-2' }));
    await waitFor(() => expect(textarea).toHaveValue('New session draft'));
    await waitFor(() => expect(findAll).toHaveBeenCalledTimes(2));

    submission.resolve(true);

    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(findAll).toHaveBeenCalledTimes(2);
    expect(findAll.mock.calls.map(([params]) => params.query.session_id)).toEqual([
      'session-1',
      'session-2',
    ]);
    expect(textarea).toHaveValue('New session draft');
    expect(localStorage.getItem('agor-draft-session-1')).toBeNull();
  });

  it('ignores deferred advanced-upload mention insertion while the composer is locked or switched', async () => {
    localStorage.setItem('agor-footer-prefs', JSON.stringify({ pinnedItems: ['advanced-upload'] }));
    localStorage.setItem('agor-draft-session-2', 'New session draft');
    const submission = deferred<boolean>();
    let insertMention: HTMLElement | null = null;
    const onSendPrompt = vi.fn().mockImplementation(() => {
      if (insertMention) fireEvent.click(insertMention);
      return submission.promise;
    });
    const { container, rerenderSession } = renderSessionPanel({ onSendPrompt });

    fireEvent.click(screen.getByTitle('Advanced upload'));
    insertMention = await screen.findByRole('button', { name: 'Insert uploaded mention' });
    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Original session prompt' } });
    fireEvent.click(container.querySelector('button.ant-btn-primary') as HTMLButtonElement);
    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));

    fireEvent.click(insertMention);
    expect(textarea).toHaveValue('Original session prompt');

    rerenderSession(makeSession({ session_id: 'session-2' }));
    await waitFor(() => expect(textarea).toHaveValue('New session draft'));
    fireEvent.click(insertMention);
    expect(textarea).toHaveValue('New session draft');

    submission.resolve(true);

    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea).toHaveValue('New session draft');
    expect(localStorage.getItem('agor-draft-session-1')).toBeNull();
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
          path: '.agor/uploads/rapid-chart.png',
          size: 11,
          mimeType: 'image/png',
        },
      ],
    });

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Attached files:\n- .agor/uploads/rapid-chart.png\n\nSummarize this rapid chart',
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
          path: '.agor/uploads/uploading-chart.png',
          size: 5,
          mimeType: 'image/png',
        },
      ],
    });

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
  });

  it('preserves prompt and uploaded attachments when prompt submission fails after upload', async () => {
    uploadMockState.uploadFilesToSession.mockResolvedValue({
      success: true,
      files: [
        {
          filename: 'preserve-chart.png',
          path: '.agor/uploads/preserve-chart.png',
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
      'Attached files:\n- .agor/uploads/preserve-chart.png\n\nKeep this prompt if submit fails',
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

  it('locks every composer action while fork and BTW submissions are pending', async () => {
    localStorage.setItem(
      'agor-footer-prefs',
      JSON.stringify({ pinnedItems: ['fork', 'spawn', 'btw-fork'] })
    );
    const fork = deferred<void>();
    const btw = deferred<void>();
    const onBtwFork = vi.fn().mockReturnValue(btw.promise);
    const onFork = vi.fn();
    renderSessionPanel({ onFork, onBtwFork });

    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    const forkButton = screen.getByLabelText('Fork session');
    const spawnButton = screen.getByLabelText('Spawn subsession');
    const btwButton = screen.getByLabelText('Ask side question via BTW fork');
    onFork.mockImplementation(() => {
      // This fires before React can commit composerBusy, so only the ref guard
      // can prevent a second composer action in the same tick.
      fireEvent.click(btwButton);
      return fork.promise;
    });

    fireEvent.change(textarea, { target: { value: 'Fork this prompt' } });
    fireEvent.click(forkButton);
    await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1));
    expect(onBtwFork).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(textarea).toBeDisabled();
      expect(forkButton).toBeDisabled();
      expect(btwButton).toBeDisabled();
      expect(spawnButton).toBeDisabled();
    });

    fork.resolve();
    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea).toHaveValue('');

    fireEvent.change(textarea, { target: { value: 'Ask this on the side' } });
    fireEvent.click(btwButton);
    await waitFor(() => expect(onBtwFork).toHaveBeenCalledTimes(1));
    expect(textarea).toBeDisabled();
    expect(forkButton).toBeDisabled();
    expect(spawnButton).toBeDisabled();

    btw.resolve();
    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea).toHaveValue('');
  });

  it('keeps all composer actions locked while spawn confirmation is pending', async () => {
    localStorage.setItem(
      'agor-footer-prefs',
      JSON.stringify({ pinnedItems: ['fork', 'spawn', 'btw-fork'] })
    );
    const spawn = deferred<unknown>();
    const create = vi.fn().mockReturnValue(spawn.promise);
    const taskEvents = { on: vi.fn(), off: vi.fn() };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'tasks') return taskEvents;
        if (name === 'links') return { findAll: vi.fn().mockResolvedValue([]) };
        if (name === 'sessions/session-1/spawn-prompt') return { create };
        return { find: vi.fn().mockResolvedValue({ data: [] }) };
      }),
    } as unknown as AgorClient;
    renderSessionPanel({ client });

    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Spawn from this prompt' } });
    fireEvent.click(screen.getByLabelText('Spawn subsession'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm spawn' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ userPrompt: 'Spawn from this prompt' })
    );
    expect(textarea).toBeDisabled();
    expect(screen.getByLabelText('Fork session')).toBeDisabled();
    expect(screen.getByLabelText('Ask side question via BTW fork')).toBeDisabled();
    expect(screen.getByLabelText('Spawn subsession')).toBeDisabled();

    spawn.resolve({});
    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea).toHaveValue('');
  });

  it('does not let an old spawn completion close or clear the new session composer', async () => {
    footerMockState.lightweight = true;
    localStorage.setItem('agor-draft-session-2', 'New session draft');
    const spawn = deferred<unknown>();
    const create = vi.fn().mockReturnValue(spawn.promise);
    const taskEvents = { on: vi.fn(), off: vi.fn() };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'tasks') return taskEvents;
        if (name === 'links') return { findAll: vi.fn().mockResolvedValue([]) };
        if (name === 'sessions/session-1/spawn-prompt') return { create };
        return { find: vi.fn().mockResolvedValue({ data: [] }) };
      }),
    } as unknown as AgorClient;
    const { rerenderSession } = renderSessionPanel({ client });

    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.change(textarea, { target: { value: 'Original spawn prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Spawn subsession' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm spawn' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    rerenderSession(makeSession({ session_id: 'session-2' }));
    await waitFor(() => expect(textarea).toHaveValue('New session draft'));
    expect(screen.getByRole('button', { name: 'Confirm spawn' })).toBeInTheDocument();

    spawn.resolve({});

    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea).toHaveValue('New session draft');
    expect(screen.getByRole('button', { name: 'Confirm spawn' })).toBeInTheDocument();
    expect(localStorage.getItem('agor-draft-session-1')).toBeNull();
  });

  it('does not let an old fork modal completion close the modal rebound to a new session', async () => {
    footerMockState.lightweight = true;
    localStorage.setItem('agor-draft-session-2', 'New session draft');
    const fork = deferred<void>();
    const onFork = vi.fn().mockReturnValue(fork.promise);
    const { rerenderSession } = renderSessionPanel({ onFork });

    const textarea = screen.getByPlaceholderText(/Prompt here/i);
    fireEvent.click(screen.getByRole('button', { name: 'Fork session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm fork modal' }));
    await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1));

    rerenderSession(makeSession({ session_id: 'session-2' }));
    await waitFor(() => expect(textarea).toHaveValue('New session draft'));
    expect(screen.getByRole('button', { name: 'Confirm fork modal' })).toBeInTheDocument();

    fork.resolve();

    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea).toHaveValue('New session draft');
    expect(screen.getByRole('button', { name: 'Confirm fork modal' })).toBeInTheDocument();
  });

  it('accepts arbitrary file types into the composer', async () => {
    const onSendPrompt = vi.fn();
    renderSessionPanel({ onSendPrompt });

    fireEvent.drop(screen.getByLabelText('Composer attachments and input drop zone'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['<script>'], 'unsafe.html', { type: 'text/html' })],
      },
    });

    await waitFor(() => expect(screen.getByLabelText('unsafe.html')).toBeInTheDocument());

    expect(uploadMockState.uploadFilesToSession).not.toHaveBeenCalled();
    expect(onSendPrompt).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Remove unsafe.html')).toBeInTheDocument();
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
        screen.getAllByText(/pending-00.txt: Composer supports up to 10 attachments \(\+10 more\)/)
          .length
      ).toBeGreaterThan(0);
    });

    expect(screen.queryByLabelText('Preview pending-00.txt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview pending-09.txt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview pending-10.txt')).not.toBeInTheDocument();
    expect(uploadMockState.uploadFilesToSession).not.toHaveBeenCalled();
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  it('shows the cap error for an over-cap batch containing arbitrary file types', async () => {
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
        screen.getAllByText(/bad.svg: Composer supports up to 10 attachments \(\+11 more\)/).length
      ).toBeGreaterThan(0);
    });

    expect(screen.queryByText(/bad.svg: Unsupported file type/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview pending-00.txt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview pending-10.txt')).not.toBeInTheDocument();
    expect(uploadMockState.uploadFilesToSession).not.toHaveBeenCalled();
    expect(onSendPrompt).not.toHaveBeenCalled();
  });
});
