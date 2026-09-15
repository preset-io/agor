/** Test-only entrypoint: actual Catalog/return UI and official Socket.IO client, no response stubs. */
import type { User } from '@agor/core/types';
import { type AgorClient, createClient } from '@agor-live/client';
import { Alert, App, ConfigProvider } from 'antd';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { CatalogTab } from '../../components/Marketplace/CatalogTab';
import { ManagedOAuthCompletePage } from '../../components/Marketplace/ManagedOAuthCompletePage';
import { captureManagedOAuthReturn } from '../../components/Marketplace/managedOAuthReturn';

// Same ordering as production: erase navigation material before authentication/network effects.
captureManagedOAuthReturn();

interface FixtureSession {
  /** Generated disposable fixture session only, never a production credential. */
  accessToken: string;
  user: User;
}
function AcceptanceApp() {
  const [session, setSession] = useState<FixtureSession | null>(null);
  const [client, setClient] = useState<AgorClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let connection: AgorClient | undefined;
    void fetch('/__managed-acceptance/session', {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Fixture session unavailable');
        return (await response.json()) as FixtureSession;
      })
      .then((identity) => {
        if (controller.signal.aborted) return;
        if (!identity.user?.user_id || !identity.accessToken)
          throw new Error('Fixture session unavailable');
        connection = createClient(window.location.origin, false, {
          reconnectionAttempts: 0,
          socketAuthentication: { accessToken: identity.accessToken },
        });
        const current = connection;
        current.io.on('connect', () => {
          if (controller.signal.aborted) return;
          setConnected(true);
          setGeneration((previous) => previous + 1);
        });
        current.io.on('disconnect', () => setConnected(false));
        current.io.on('connect_error', () => setError(true));
        setSession(identity);
        setClient(current);
        current.io.connect();
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => {
      controller.abort();
      connection?.io.disconnect();
    };
  }, []);
  if (error) return <Alert type="error" title="Acceptance fixture connection unavailable" />;
  if (!session || !client)
    return <Alert type="info" title="Loading authenticated fixture session" />;
  if (/^\/(?:ui\/)?mcp-oauth\/complete\/?$/.test(window.location.pathname)) {
    return (
      <ManagedOAuthCompletePage
        client={connected ? client : null}
        userId={session.user.user_id}
        authorityKey={connected ? `${session.user.user_id}:${generation}` : null}
      />
    );
  }
  return (
    <CatalogTab
      client={client}
      currentUser={session.user}
      connected={connected}
      connecting={!connected}
      authGeneration={generation}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <ConfigProvider theme={{ token: { motion: false } }}>
    <App>
      <BrowserRouter>
        <AcceptanceApp />
      </BrowserRouter>
    </App>
  </ConfigProvider>
);
