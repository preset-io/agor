import { sessionPath } from '@agor-live/client';
import { lazy, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMCPCatalogModal } from '../../contexts/MCPCatalogModalContext';
import type { MCPCatalogModalProps } from './MCPCatalogModal';

const MCPCatalogModal = lazy(() =>
  import('./MCPCatalogModal').then((module) => ({ default: module.MCPCatalogModal }))
);

export function MCPCatalogModalHost(
  props: Omit<MCPCatalogModalProps, 'open' | 'onClose' | 'afterClose' | 'onOpenSession'>
) {
  const catalog = useMCPCatalogModal();
  const navigate = useNavigate();
  if (!catalog?.mounted) return null;
  return (
    <Suspense fallback={null}>
      <MCPCatalogModal
        {...props}
        open={catalog.open}
        onClose={catalog.closeCatalog}
        afterClose={catalog.afterClose}
        onOpenSession={(sessionId) => {
          // A detail drawer portals independently of the outer Modal. Destroy
          // the complete owner synchronously BEFORE rendering the destination.
          flushSync(catalog.dismissForNavigation);
          navigate(sessionPath(sessionId));
        }}
      />
    </Suspense>
  );
}
