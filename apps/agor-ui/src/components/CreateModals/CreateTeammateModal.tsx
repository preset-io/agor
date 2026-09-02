import type { AgorClient, CreateRepoRequest, User } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById, selectRepoById } from '../../store/selectors';
import type { AgenticToolOption } from '../../types';
import type { TeammateTabResult } from '../CreateDialog/tabs/TeammateTab';
import { TeammateTab } from '../CreateDialog/tabs/TeammateTab';
import { CreateModalShell } from './CreateModalShell';

const PURPOSE =
  'AI teammates are long-lived agents with an identity, purpose, and goals. They have memory, can build their own skills, coordinate multiple coding agents, typically operate on their own Agor board, and can act proactively.';

export interface TeammateProgress {
  onStatusChange?: (status: string) => void;
}

export interface CreateTeammateModalProps {
  open: boolean;
  onClose: () => void;
  availableAgents: AgenticToolOption[];
  currentUser?: User | null;
  client?: AgorClient | null;
  onCreateRepo?: (data: CreateRepoRequest) => unknown;
  onCreateTeammate?: (
    result: TeammateTabResult,
    progress?: TeammateProgress
  ) => void | Promise<void>;
}

/** Standalone "New AI teammate" modal — template-first, single screen. */
export const CreateTeammateModal: React.FC<CreateTeammateModalProps> = ({
  open,
  onClose,
  availableAgents,
  currentUser,
  client,
  onCreateRepo,
  onCreateTeammate,
}) => {
  const repoById = useAgorStore(selectRepoById);
  const mcpServerById = useAgorStore(selectMcpServerById);
  const [isValid, setIsValid] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const formRef = useRef<(() => Promise<TeammateTabResult | null>) | null>(null);

  // Reset transient state when the modal closes (the body itself is torn down
  // by destroyOnHidden).
  useEffect(() => {
    if (!open) {
      setIsValid(false);
      setIsSubmitting(false);
      setSubmitStatus(null);
      setSubmitError(null);
    }
  }, [open]);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitStatus(null);
    try {
      const result = await formRef.current?.();
      if (result) {
        setSubmitStatus('Creating AI teammate…');
        await onCreateTeammate?.(result, { onStatusChange: setSubmitStatus });
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
      title="New AI teammate"
      description={PURPOSE}
      submitLabel="Create AI teammate"
      onCancel={onClose}
      onSubmit={handleSubmit}
      submitDisabled={!isValid}
      isSubmitting={isSubmitting}
      submitStatus={submitStatus}
      submitError={submitError}
      width={720}
    >
      <TeammateTab
        repoById={repoById}
        onValidityChange={setIsValid}
        formRef={formRef}
        onCreateRepo={onCreateRepo}
        availableAgents={availableAgents}
        mcpServerById={mcpServerById}
        currentUser={currentUser}
        client={client}
      />
    </CreateModalShell>
  );
};
