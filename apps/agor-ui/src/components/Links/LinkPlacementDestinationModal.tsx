import { Button, Empty, List, Modal, Typography } from 'antd';
import type { LinkPromotionAction } from './linkPromotion';
import {
  LINK_ACTION_LABEL,
  LINK_DESTINATION_COPY,
  LINK_OWNER_SCOPE,
  LINK_PLACEMENT_OPERATION,
  type LinkOwnerScope,
} from './linkUiConstants';

export type LinkPlacementDestinationScope = LinkOwnerScope;

export interface LinkPlacementDestinationOption {
  key: string;
  label: string;
  description?: string;
  action: LinkPromotionAction;
}

interface LinkPlacementDestinationModalProps {
  open: boolean;
  scope: LinkPlacementDestinationScope;
  options: readonly LinkPlacementDestinationOption[];
  busy: boolean;
  onClose: () => void;
  onAction: (action: LinkPromotionAction) => Promise<unknown>;
}

export function LinkPlacementDestinationModal({
  open,
  scope,
  options,
  busy,
  onClose,
  onAction,
}: LinkPlacementDestinationModalProps) {
  const branchScope = scope === LINK_OWNER_SCOPE.branch;
  return (
    <Modal
      open={open}
      title={branchScope ? LINK_DESTINATION_COPY.branchTitle : LINK_DESTINATION_COPY.sessionTitle}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      {options.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            branchScope ? LINK_DESTINATION_COPY.emptyBranches : LINK_DESTINATION_COPY.emptySessions
          }
        />
      ) : (
        <List
          dataSource={[...options]}
          renderItem={(option) => (
            <List.Item
              actions={[
                <Button
                  key={option.action.key}
                  disabled={busy || option.action.disabled}
                  loading={busy}
                  onClick={() => void onAction(option.action)}
                >
                  {option.action.operation === LINK_PLACEMENT_OPERATION.remove
                    ? LINK_ACTION_LABEL.remove
                    : LINK_ACTION_LABEL.promote}
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={<Typography.Text>{option.label}</Typography.Text>}
                description={option.description}
              />
            </List.Item>
          )}
        />
      )}
    </Modal>
  );
}
