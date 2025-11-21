/**
 * Modal for confirming zone deletion with options for handling associated sessions
 */

import { Modal, Radio, theme } from 'antd';
import { useState } from 'react';

interface DeleteZoneModalProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (deleteAssociatedSessions: boolean) => void;
  zoneName: string;
  sessionCount: number;
}

export const DeleteZoneModal = ({
  open,
  onCancel,
  onConfirm,
  zoneName,
  sessionCount,
}: DeleteZoneModalProps) => {
  const { token } = theme.useToken();
  const [deleteAssociatedSessions, setDeleteAssociatedSessions] = useState(false);

  const handleOk = () => {
    onConfirm(deleteAssociatedSessions);
  };

  return (
    <Modal
      title="Delete Zone"
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      okText="Delete Zone"
      okButtonProps={{
        danger: true,
      }}
      cancelText="Cancel"
      width={480}
    >
      <div style={{ marginBottom: 16 }}>
        <p style={{ margin: 0, marginBottom: 16 }}>Are you sure you want to delete this zone?</p>

        {sessionCount > 0 && (
          <>
            <p style={{ margin: 0, marginBottom: 16, color: token.colorTextSecondary }}>
              This zone has {sessionCount} pinned session{sessionCount !== 1 ? 's' : ''}.
            </p>

            <Radio.Group
              value={deleteAssociatedSessions}
              onChange={(e) => setDeleteAssociatedSessions(e.target.value)}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Radio value={false}>
                  <div>
                    <div style={{ fontWeight: 500 }}>Unpin sessions (keep on board)</div>
                    <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
                      Sessions will remain on the board at their current positions
                    </div>
                  </div>
                </Radio>
                <Radio value={true} disabled>
                  <div>
                    <div style={{ fontWeight: 500 }}>
                      Delete pinned sessions too{' '}
                      <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
                        [coming soon]
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
                      Remove sessions from board entirely
                    </div>
                  </div>
                </Radio>
              </div>
            </Radio.Group>
          </>
        )}

        {sessionCount === 0 && (
          <p style={{ margin: 0, color: token.colorTextSecondary }}>
            This zone has no pinned sessions.
          </p>
        )}
      </div>
    </Modal>
  );
};
