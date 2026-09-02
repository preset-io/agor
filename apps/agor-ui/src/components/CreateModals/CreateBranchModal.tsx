import { useEffect, useRef, useState } from 'react';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectRepoById } from '../../store/selectors';
import type { BranchTabConfig } from '../CreateDialog/tabs/BranchTab';
import { BranchTab } from '../CreateDialog/tabs/BranchTab';
import { CreateModalShell } from './CreateModalShell';

const PURPOSE = (
  <>
    A branch (built on{' '}
    <a href="https://git-scm.com/docs/git-branch" target="_blank" rel="noopener noreferrer">
      git branches
    </a>
    ) is an isolated place in the filesystem where one or more coding sessions take place. In Agor
    they're generally ephemeral and follow the lifecycle of a given feature.
  </>
);

export interface CreateBranchModalProps {
  open: boolean;
  onClose: () => void;
  currentBoardId?: string;
  defaultPosition?: { x: number; y: number };
  onCreateBranch: (config: BranchTabConfig) => void | Promise<void>;
  branchStorageConfig?: BranchStorageConfig;
}

/** Standalone "New branch" modal. Board placement is a field within the form. */
export const CreateBranchModal: React.FC<CreateBranchModalProps> = ({
  open,
  onClose,
  currentBoardId,
  defaultPosition,
  onCreateBranch,
  branchStorageConfig,
}) => {
  const repoById = useAgorStore(selectRepoById);
  const boardById = useAgorStore(selectBoardById);
  const [isValid, setIsValid] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const formRef = useRef<(() => Promise<BranchTabConfig | null>) | null>(null);

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
      const config = await formRef.current?.();
      if (config) {
        await onCreateBranch(config);
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
      title="New branch"
      description={PURPOSE}
      submitLabel="Create Branch"
      onCancel={onClose}
      onSubmit={handleSubmit}
      submitDisabled={!isValid}
      isSubmitting={isSubmitting}
      submitError={submitError}
    >
      <BranchTab
        repoById={repoById}
        boardById={boardById}
        currentBoardId={currentBoardId}
        defaultPosition={defaultPosition}
        onValidityChange={setIsValid}
        formRef={formRef}
        branchStorageConfig={branchStorageConfig}
      />
    </CreateModalShell>
  );
};
