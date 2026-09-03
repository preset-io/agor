import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { AppNode } from './AppNode';
import { ArtifactNode } from './ArtifactNode';
import { MarkdownNode } from './MarkdownNode';

const resizerSpy = vi.hoisted(() => vi.fn());

vi.mock('reactflow', () => ({
  NodeResizer: (props: { isVisible?: boolean }) => {
    resizerSpy(props);
    return <div data-testid="node-resizer" data-visible={String(Boolean(props.isVisible))} />;
  },
}));

vi.mock('@codesandbox/sandpack-react', () => ({
  SandpackProvider: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SandpackPreview: () => <div data-testid="sandpack-preview" />,
  useSandpack: () => ({ sandpack: { files: {}, environment: 'react' } }),
}));

vi.mock('@/utils/sandpackCrypto', () => ({
  ensureSandpackCryptoSubtle: vi.fn(),
}));

const connection = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <ConnectionProvider value={connection}>
    <AntApp>{children}</AntApp>
  </ConnectionProvider>
);

beforeEach(() => {
  resizerSpy.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => undefined))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('structural board-object controls', () => {
  it('disables Markdown edit and delete controls when board.edit is revoked', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const data = {
      objectId: 'note-1',
      content: 'Review notes',
      width: 400,
      canEdit: true,
      onUpdate: vi.fn(),
      onEdit,
      onDelete,
    };
    const { container, rerender } = render(<MarkdownNode data={data} />, { wrapper });

    expect(container.querySelector('button[aria-label="Edit note"]')).toBeEnabled();
    rerender(<MarkdownNode data={{ ...data, canEdit: false }} />);

    const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Edit note"]');
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Delete note"]');
    expect(edit).toBeDisabled();
    expect(remove).toBeDisabled();
    fireEvent.click(edit!);
    fireEvent.click(remove!);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('hides the App resizer and disables deletion when board.edit is revoked', () => {
    const onDelete = vi.fn();
    const data = {
      objectId: 'app-1',
      title: 'Preview',
      template: 'react' as const,
      files: { '/src.tsx': 'export default null' },
      width: 400,
      height: 300,
      canEdit: true,
      onUpdate: vi.fn(),
      onDelete,
    };
    const { container, rerender } = render(<AppNode data={data} selected />, { wrapper });

    expect(screen.getByTestId('node-resizer')).toHaveAttribute('data-visible', 'true');
    rerender(<AppNode data={{ ...data, canEdit: false }} selected />);

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Delete app"]');
    expect(screen.getByTestId('node-resizer')).toHaveAttribute('data-visible', 'false');
    expect(remove).toBeDisabled();
    fireEvent.click(remove!);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('hides the Artifact resizer and disables layout locking after revocation', () => {
    const onUpdate = vi.fn();
    const data = {
      objectId: 'artifact-object-1',
      artifactId: 'artifact-1',
      width: 400,
      height: 300,
      canEdit: true,
      onUpdate,
      x: 10,
      y: 20,
      locked: false,
      onDeleteArtifact: vi.fn(),
    };
    const { container, rerender } = render(<ArtifactNode data={data} selected />, { wrapper });

    expect(screen.getByTestId('node-resizer')).toHaveAttribute('data-visible', 'true');
    rerender(<ArtifactNode data={{ ...data, canEdit: false }} selected />);

    const lock = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Lock artifact card"]'
    );
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete artifact"]'
    );
    expect(screen.getByTestId('node-resizer')).toHaveAttribute('data-visible', 'false');
    expect(lock).toBeDisabled();
    // Artifact lifecycle deletion keeps its creator/admin authorization path;
    // board.edit gates only layout controls here.
    expect(remove).toBeEnabled();
    fireEvent.click(lock!);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
