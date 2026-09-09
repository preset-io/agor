import { sessionPath } from '@agor-live/client';
import { lazy, Suspense, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  type MCPCatalogSelection,
  useMCPCatalogModal,
} from '../../contexts/MCPCatalogModalContext';
import type { MCPCatalogModalProps } from './MCPCatalogModal';

const MCPCatalogModal = lazy(() =>
  import('./MCPCatalogModal').then((module) => ({ default: module.MCPCatalogModal }))
);

export function MCPCatalogModalHost({
  onboardingHandoff,
  onHandoffConsumed,
  ...props
}: Omit<MCPCatalogModalProps, 'open' | 'onClose' | 'afterClose' | 'onOpenSession'> & {
  onboardingHandoff?: MCPCatalogSelection;
  onHandoffConsumed?: () => void;
}) {
  const catalog = useMCPCatalogModal();
  const navigate = useNavigate();
  const openCatalog = catalog?.openCatalog;
  useEffect(() => {
    if (!onboardingHandoff || !openCatalog) return;
    openCatalog(null, onboardingHandoff);
    onHandoffConsumed?.();
  }, [onboardingHandoff, openCatalog, onHandoffConsumed]);
  if (!catalog?.mounted) return null;
  return (
    <Suspense fallback={null}>
      <MCPCatalogModal
        {...props}
        initialSelection={catalog.selection}
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
