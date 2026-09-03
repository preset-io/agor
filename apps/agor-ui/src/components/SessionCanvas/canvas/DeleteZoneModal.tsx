/**
 * Modal for confirming zone deletion and explaining its non-destructive scope.
 */

import { Alert, Modal, Typography } from 'antd';
import { useMutationGate } from '../../../contexts/ConnectionContext';

interface DeleteZoneModalProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  zoneName: string;
  pinnedItemCount: number;
}

export const DeleteZoneModal = ({
  open,
  onCancel,
  onConfirm,
  zoneName,
  pinnedItemCount,
}: DeleteZoneModalProps) => {
  const mutationGate = useMutationGate();

  const handleOk = () => {
    if (!mutationGate.canMutate) return;
    onConfirm();
  };

  return (
    <Modal
      title="Delete zone?"
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      okText="Delete zone"
      okButtonProps={{
        danger: true,
        disabled: !mutationGate.canMutate,
      }}
      cancelText="Cancel"
      width={480}
    >
      <Typography.Paragraph>
        Delete <Typography.Text strong>{zoneName}</Typography.Text>? This removes only the zone.
        Branches, cards, comments, notes, and sessions are kept.
      </Typography.Paragraph>

      {pinnedItemCount > 0 ? (
        <Alert
          type="info"
          showIcon
          title={`${pinnedItemCount} pinned ${pinnedItemCount === 1 ? 'branch/card' : 'branches/cards'} will be unpinned`}
          description="They will remain on the board at the same visible positions. Their content and session history are not changed."
        />
      ) : (
        <Typography.Paragraph type="secondary">
          Nothing else on the board will be removed.
        </Typography.Paragraph>
      )}
    </Modal>
  );
};
