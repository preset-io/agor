import type { Branch } from '@agor-live/client';
import { AdaptiveSettingsModal } from '../SettingsModal/AdaptiveSettingsModal';
import { ExportPackPanel } from './ExportPackPanel';

export interface ExportPackModalProps {
  open: boolean;
  teammates: Branch[];
  initialBranchIds: string[];
  onClose: () => void;
}

export const ExportPackModal: React.FC<ExportPackModalProps> = ({
  open,
  teammates,
  initialBranchIds,
  onClose,
}) => (
  <AdaptiveSettingsModal
    title="Export teammates (.agorpack)"
    open={open}
    onCancel={onClose}
    footer={null}
    width={720}
    destroyOnHidden
  >
    <ExportPackPanel teammates={teammates} initialBranchIds={initialBranchIds} />
  </AdaptiveSettingsModal>
);
