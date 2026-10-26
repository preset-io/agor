import type { AgorClient, Board, CardWithType, User } from '@agor-live/client';
import { Button, Empty, Flex, Input, Modal, Typography, theme } from 'antd';
import { useCallback, useMemo, useRef, useState } from 'react';
import { type Node, ReactFlowProvider } from 'reactflow';
import { useBoardMutationGuard } from '../../hooks/useBoardMutationGuard';
import { useCanManageBoard } from '../../hooks/useCanManageBoard';
import { useAgorStore } from '../../store/agorStore';
import type { BoardWriteTicket } from '../../store/boardMutationGuard';
import { selectArtifactById, selectCardById } from '../../store/selectors';
import { formatActionError } from '../../utils/connectionErrors';
import { useThemedMessage } from '../../utils/message';
import CardModal from '../CardModal';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { AppNode } from '../SessionCanvas/canvas/AppNodeLazy';
import { ArtifactNode } from '../SessionCanvas/canvas/ArtifactNodeLazy';
import { MarkdownNode } from '../SessionCanvas/canvas/MarkdownNode';
import { useBoardObjects } from '../SessionCanvas/canvas/useBoardObjects';

export type BoardContentSelection = { kind: 'object' | 'card'; id: string };
export interface BoardContentEntry {
  selection: BoardContentSelection;
  title: string;
  type: string;
}
export function useBoardContentEntries(board: Board) {
  const cards = useAgorStore(selectCardById);
  const artifacts = useAgorStore(selectArtifactById);
  return useMemo(
    () =>
      [
        ...Object.entries(board.objects ?? {})
          .filter(([, o]) => o.type !== 'zone')
          .map(
            ([id, o]): BoardContentEntry => ({
              selection: { kind: 'object', id },
              type: o.type,
              title:
                o.type === 'artifact'
                  ? (artifacts.get(o.artifact_id)?.name ?? 'Artifact')
                  : o.type === 'app'
                    ? o.title
                    : o.type === 'markdown' || o.type === 'text'
                      ? o.content
                          .split('\n')
                          .find((line) => line.trim())
                          ?.replace(/^#+\s*/, '')
                          .slice(0, 100) || 'Untitled note'
                      : 'Zone',
            })
          ),
        ...Array.from(cards.values())
          .filter((c) => c.board_id === board.board_id && !c.archived)
          .map(
            (c): BoardContentEntry => ({
              selection: { kind: 'card', id: c.card_id },
              title: c.title,
              type: 'card',
            })
          ),
      ].sort((a, b) => a.title.localeCompare(b.title)),
    [board.objects, board.board_id, cards, artifacts]
  );
}

/** The same renderers and ticketed object actions as the canvas, without a canvas.
 * NodeResizer is disabled in embedded mode: opening content must never persist
 * the detail pane's dimensions into the shared spatial arrangement. */
export function BoardContentDetail({
  board,
  client,
  user,
  selection,
  onClose,
}: {
  board: Board;
  client: AgorClient | null;
  user?: User;
  selection: BoardContentSelection;
  onClose: () => void;
}) {
  const { token } = theme.useToken();
  const canEdit = useCanManageBoard(client, board, user);
  const guard = useBoardMutationGuard(board.board_id, canEdit);
  const { showError } = useThemedMessage();
  const cards = useAgorStore(selectCardById);
  const [, setNodes] = useState<Node[]>([]);
  const deletedObjectsRef = useRef(new Set<string>());
  const [editor, setEditor] = useState<{
    id: string;
    content: string;
    ticket: BoardWriteTicket | null;
  } | null>(null);
  const edit = useCallback(
    (id: string, content: string) => setEditor({ id, content, ticket: guard.capture() }),
    [guard]
  );
  const { buildObjectNode } = useBoardObjects({
    board,
    client,
    boardObjectsForBoard: [],
    setNodes,
    deletedObjectsRef,
    guard,
    onEditMarkdown: edit,
  });
  const object = selection.kind === 'object' ? board.objects?.[selection.id] : undefined;
  const card = selection.kind === 'card' ? cards.get(selection.id) : undefined;
  const node = object ? buildObjectNode(selection.id, object) : undefined;
  const [saving, setSaving] = useState(false);
  const editorCurrent = !!editor && guard.isCurrent(editor.ticket) && !!board.objects?.[editor.id];
  const save = async () => {
    if (!editor || !client || !editorCurrent) return;
    setSaving(true);
    try {
      // Narrow merge: an edit cannot restore an object deleted by another
      // viewer or revert a simultaneous move on the shared canvas.
      if (
        await guard.write(
          editor.ticket,
          () =>
            client.service('boards').patch(board.board_id, {
              _action: 'mergeObjectFields',
              objects: { [editor.id]: { content: editor.content } },
            } as unknown as Partial<Board>),
          'The board changed. Reopen the note editor before saving.'
        )
      )
        setEditor(null);
    } catch (error) {
      showError(formatActionError('save the note', error, { idempotent: true }));
    } finally {
      setSaving(false);
    }
  };
  let content: React.ReactNode = <Empty description="This content is no longer available." />;
  if (card?.board_id === board.board_id)
    content = (
      <CardModal
        embedded
        open
        card={card as CardWithType}
        board={board}
        client={client}
        onClose={onClose}
        requireLoadedBoard
      />
    );
  else if (object && node) {
    if (object.type === 'artifact') content = <ArtifactNode embedded data={node.data} />;
    else if (object.type === 'app') content = <AppNode embedded data={node.data} />;
    else if (object.type === 'markdown') content = <MarkdownNode embedded data={node.data} />;
    else if (object.type === 'text') content = <MarkdownRenderer content={object.content} />;
  }
  return (
    <Flex vertical style={{ height: '100%', minHeight: 0 }}>
      <Flex justify="end" style={{ padding: token.paddingXS }}>
        <Button onClick={onClose}>Close content</Button>
      </Flex>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: token.padding }}>
        <ReactFlowProvider>{content}</ReactFlowProvider>
      </div>
      {editor && (
        <Modal
          open
          title="Edit note"
          onCancel={() => setEditor(null)}
          onOk={() => void save()}
          confirmLoading={saving}
          okButtonProps={{ disabled: !editorCurrent }}
        >
          <Input.TextArea
            aria-label="Note content"
            autoSize={{ minRows: 8, maxRows: 20 }}
            value={editor.content}
            onChange={(e) => setEditor({ ...editor, content: e.target.value })}
          />
          {!editorCurrent && (
            <Typography.Text type="warning">
              The board changed. Copy your draft and reopen the editor to save.
            </Typography.Text>
          )}
        </Modal>
      )}
    </Flex>
  );
}
