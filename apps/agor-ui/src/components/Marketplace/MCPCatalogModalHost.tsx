import { sessionPath } from '@agor-live/client';
import { lazy, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMCPCatalogModal } from '../../contexts/MCPCatalogModalContext';
import type { MCPCatalogModalProps } from './MCPCatalogModal';

const MCPCatalogModal = lazy(() =>
  import('./MCPCatalogModal').then((module) => ({ default: module.MCPCatalogModal }))
);
const CatalogTab = lazy(() =>
  import('./CatalogTab').then((module) => ({ default: module.CatalogTab }))
);

export function MCPCatalogModalHost(
  props: Omit<MCPCatalogModalProps, 'open' | 'onClose' | 'afterClose' | 'onOpenSession'>
) {
  const catalog = useMCPCatalogModal();
  const navigate = useNavigate();
  if (!catalog) return null;
  const handoff = catalog.entryHandoff;
  return (
    <>
      {catalog.mounted && (
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
      )}
      {handoff && (
        // The Catalog's own drawer for one entry, in the same handoff mode
        // onboarding uses: one connect path, ending in `onConnected`.
        <Suspense fallback={null}>
          <CatalogTab
            key={handoff.entryName}
            client={props.client}
            connected={props.connected}
            connecting={props.connecting}
            authGeneration={props.authGeneration}
            currentUser={props.currentUser}
            context={{
              mode: 'handoff',
              entryName: handoff.entryName,
              returnTo: handoff.returnTo,
              onClose: () => {
                catalog.closeCatalogEntry();
                handoff.onClose?.();
              },
              onConnected: (serverId) => {
                catalog.closeCatalogEntry();
                handoff.onConnected(serverId);
              },
            }}
          />
        </Suspense>
      )}
    </>
  );
}
