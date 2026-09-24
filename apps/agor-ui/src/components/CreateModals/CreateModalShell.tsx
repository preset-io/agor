import type { ModalProps } from 'antd';
import { Alert, Button, Modal } from 'antd';

// Full-screen (mobile) surface: edge-to-edge content with a scrollable body
// that clears the device safe area.
const FULLSCREEN_STYLES: ModalProps['styles'] = {
  container: { height: '100dvh', borderRadius: 0, display: 'flex', flexDirection: 'column' },
  body: { flex: 1, overflow: 'auto', paddingBottom: 'env(safe-area-inset-bottom)' },
};

export interface CreateModalShellProps {
  open: boolean;
  title: React.ReactNode;
  /** Short purpose blurb rendered as an info alert above the body. */
  description?: React.ReactNode;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: () => void;
  submitDisabled?: boolean;
  isSubmitting?: boolean;
  /** Transient status label shown on the submit button while working. */
  submitStatus?: string | null;
  submitError?: string | null;
  width?: number;
  /** Render edge-to-edge (mobile): full viewport width/height, no rounded corners. */
  fullScreen?: boolean;
  children: React.ReactNode;
}

/**
 * Thin, single-purpose modal chrome shared by every create modal: title, an
 * optional purpose alert, a body slot, and a cancel/submit footer with loading
 * and error handling. Replaces the 4-tab CreateDialog's shared frame so each
 * flow is its own focused modal without duplicating this chrome.
 */
export const CreateModalShell: React.FC<CreateModalShellProps> = ({
  open,
  title,
  description,
  submitLabel,
  onCancel,
  onSubmit,
  submitDisabled,
  isSubmitting,
  submitStatus,
  submitError,
  width = 640,
  fullScreen = false,
  children,
}) => (
  <Modal
    title={title}
    open={open}
    onCancel={() => {
      if (!isSubmitting) onCancel();
    }}
    destroyOnHidden
    width={fullScreen ? '100vw' : width}
    style={fullScreen ? { top: 0, maxWidth: '100vw', margin: 0, paddingBottom: 0 } : undefined}
    styles={fullScreen ? FULLSCREEN_STYLES : undefined}
    closable={!isSubmitting}
    maskClosable={false}
    keyboard={!isSubmitting}
    footer={[
      <Button key="cancel" onClick={onCancel} disabled={isSubmitting}>
        Cancel
      </Button>,
      <Button
        key="submit"
        type="primary"
        onClick={onSubmit}
        disabled={submitDisabled}
        loading={isSubmitting}
      >
        {isSubmitting && submitStatus ? submitStatus : submitLabel}
      </Button>,
    ]}
  >
    {description && (
      <Alert type="info" showIcon description={description} style={{ marginBottom: 16 }} />
    )}
    {children}
    {submitError && (
      <Alert
        type="error"
        showIcon
        message="Couldn't finish creating this item"
        description={submitError}
        style={{ marginTop: 16 }}
      />
    )}
  </Modal>
);
