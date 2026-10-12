import type { GlobalToken, ModalProps } from 'antd';
import { Alert, Button, Modal, theme } from 'antd';

// Screen-height surface: header and footer stay pinned while only the body
// scrolls. Desktop keeps the standard margin above and below; full-screen
// (mobile) runs edge to edge and clears the device safe area.
const shellStyles = (token: GlobalToken, fullScreen: boolean): ModalProps['styles'] => ({
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: fullScreen ? '100dvh' : `calc(100dvh - ${token.marginXL * 2}px)`,
    ...(fullScreen ? { borderRadius: 0 } : {}),
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    // Room for focus rings, which the scroll container would otherwise clip.
    paddingInline: token.paddingXXS,
    marginInline: -token.paddingXXS,
    ...(fullScreen ? { paddingBottom: 'env(safe-area-inset-bottom)' } : {}),
  },
});

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
}) => {
  const { token } = theme.useToken();
  return (
    <Modal
      title={title}
      open={open}
      onCancel={() => {
        if (!isSubmitting) onCancel();
      }}
      destroyOnHidden
      width={fullScreen ? '100vw' : width}
      style={fullScreen ? { top: 0, maxWidth: '100vw', margin: 0, paddingBottom: 0 } : undefined}
      centered={!fullScreen}
      styles={shellStyles(token, fullScreen)}
      closable={!isSubmitting}
      mask={{ closable: false }}
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
        <Alert
          type="info"
          showIcon
          description={description}
          style={{ marginBottom: token.margin }}
        />
      )}
      {children}
      {submitError && (
        <Alert
          type="error"
          showIcon
          message="Couldn't finish creating this item"
          description={submitError}
          style={{ marginTop: token.margin }}
        />
      )}
    </Modal>
  );
};
