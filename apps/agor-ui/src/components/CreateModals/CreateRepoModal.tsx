import type { CreateLocalRepoRequest, CreateRepoRequest } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import type { RepoTabResult } from '../CreateDialog/tabs/RepoTab';
import { RepoTab } from '../CreateDialog/tabs/RepoTab';
import { CreateModalShell } from './CreateModalShell';

const PURPOSE =
  'Repositories connect your code to Agor. They can be cloned from GitHub or registered from a local path. Once connected, you can create branches for coding tasks.';

export interface CreateRepoModalProps {
  open: boolean;
  onClose: () => void;
  onCreateRepo: (data: CreateRepoRequest) => unknown;
  onCreateLocalRepo: (data: CreateLocalRepoRequest) => void | Promise<void>;
}

/** Standalone "New repository" modal (remote clone or local path). */
export const CreateRepoModal: React.FC<CreateRepoModalProps> = ({
  open,
  onClose,
  onCreateRepo,
  onCreateLocalRepo,
}) => {
  const [isValid, setIsValid] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const formRef = useRef<(() => Promise<RepoTabResult | null>) | null>(null);

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
      const result = await formRef.current?.();
      if (result) {
        if (result.mode === 'local' && result.local) {
          await onCreateLocalRepo(result.local);
        } else if (result.remote) {
          await onCreateRepo(result.remote);
        }
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
      title="New repository"
      description={PURPOSE}
      submitLabel="Add Repository"
      onCancel={onClose}
      onSubmit={handleSubmit}
      submitDisabled={!isValid}
      isSubmitting={isSubmitting}
      submitError={submitError}
    >
      <RepoTab onValidityChange={setIsValid} formRef={formRef} />
    </CreateModalShell>
  );
};
