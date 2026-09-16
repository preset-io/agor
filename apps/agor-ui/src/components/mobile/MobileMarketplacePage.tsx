import type { SessionID, User } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { theme } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useConnectionState } from '../../contexts/ConnectionContext';
import { MCPCatalogContent } from '../Marketplace';
import { mobileScrollAreaStyle } from './constants';
import { MobileHeader } from './MobileHeader';

interface MobileMarketplacePageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  authGeneration: number;
  commentsBadge?: number;
  onOpenComments?: () => void;
}

/**
 * Marketplace tab: the MCP Catalog rendered full-screen in the mobile shell. It
 * reuses the same MCPCatalogContent the desktop MCPCatalogModal wraps (component
 * reuse, not the modal chrome), so browse/connect behaves identically.
 */
export const MobileMarketplacePage: React.FC<MobileMarketplacePageProps> = ({
  client,
  currentUser,
  authGeneration,
  commentsBadge,
  onOpenComments,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const { connected, connecting } = useConnectionState();

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <MobileHeader
        title="Marketplace"
        onSearch={() => navigate('/m/search')}
        commentsBadge={commentsBadge}
        onOpenComments={onOpenComments}
      />
      <div style={{ ...mobileScrollAreaStyle, paddingInline: token.padding }}>
        <MCPCatalogContent
          client={client}
          connected={connected}
          connecting={connecting}
          authGeneration={authGeneration}
          currentUser={currentUser}
          active
          onOpenSession={(sessionId: SessionID) => navigate(`/m/session/${sessionId}`)}
        />
      </div>
    </div>
  );
};
