import type { SessionID, User } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { ShopOutlined } from '@ant-design/icons';
import { Modal, Space, theme } from 'antd';
import { MCPCatalogContent } from './MCPCatalogContent';

export interface MCPCatalogModalProps {
  client: AgorClient | null;
  connected: boolean;
  connecting: boolean;
  authGeneration: number;
  currentUser?: User | null;
  open: boolean;
  onClose: () => void;
  afterClose: () => void;
  onOpenSession: (sessionId: SessionID) => void;
}

/** One ephemeral shell around the existing Catalog and caller-scoped personal tabs. */
export function MCPCatalogModal({
  client,
  connected,
  connecting,
  authGeneration,
  currentUser,
  open,
  onClose,
  afterClose,
  onOpenSession,
}: MCPCatalogModalProps) {
  const { token } = theme.useToken();

  return (
    <Modal
      title={
        <Space>
          <ShopOutlined aria-hidden />
          <span>MCP Catalog</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      afterClose={afterClose}
      focusable={{ focusTriggerAfterClose: false }}
      footer={null}
      width={1200}
      style={{
        top: token.margin,
        maxWidth: `calc(100vw - ${token.marginSM * 2}px)`,
        paddingBottom: 0,
      }}
      styles={{
        body: {
          height: `min(760px, calc(100dvh - ${token.margin * 2 + 100}px))`,
          overflow: 'auto',
        },
      }}
    >
      <MCPCatalogContent
        client={client}
        connected={connected}
        connecting={connecting}
        authGeneration={authGeneration}
        currentUser={currentUser}
        active={open}
        onOpenSession={onOpenSession}
      />
    </Modal>
  );
}
