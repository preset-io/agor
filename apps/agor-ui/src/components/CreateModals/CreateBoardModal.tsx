import type { Board } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { BoardTab } from '../CreateDialog/tabs/BoardTab';
import { CreateModalShell } from './CreateModalShell';

const PURPOSE =
  'Boards are spatial canvases for organizing work. They contain branches, zones, cards, and other visual elements. Use boards to create workspaces for teams, projects, or teammates.';

export interface CreateBoardModalProps {
  open: boolean;
  onClose: () => void;
  onCreateBoard: (board: Partial<Board>) => void | Promise<void>;
}

/** Standalone "New board" modal. */
export const CreateBoardModal: React.FC<CreateBoardModalProps> = ({
  open,
  onClose,
  onCreateBoard,
}) => {
  const [isValid, setIsValid] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const formRef = useRef<(() => Promise<Partial<Board> | null>) | null>(null);

  useEffect(() => {
    if (!open) {
      setIsValid(false);
      setIsSubmitting(false);
      setSubmitError(null);
    }
  }, [open]);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const board = await formRef.current?.();
      if (board) {
        await onCreateBoard(board);
        onClose();
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <CreateModalShell
      open={open}
      title="New board"
      description={PURPOSE}
      submitLabel="Create Board"
      onCancel={onClose}
      onSubmit={handleSubmit}
      submitDisabled={!isValid}
      isSubmitting={isSubmitting}
      submitError={submitError}
    >
      <BoardTab onValidityChange={setIsValid} formRef={formRef} />
    </CreateModalShell>
  );
};
