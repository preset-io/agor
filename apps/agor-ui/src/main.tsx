import { type AgorClient, preloadRestClientTransport } from '@agor-live/client';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { prefetchAuthConfig } from './hooks/useAuthConfig';
import './index.css';
import { installClipboardPolyfill } from './utils/clipboard-polyfill';

declare global {
  interface Window {
    __agorClient?: AgorClient;
  }
}

// Install clipboard polyfill for non-HTTPS environments
// This ensures Streamdown's copy buttons work on HTTP and local network IPs
installClipboardPolyfill();

// Cleanup WebSocket connections on Vite HMR
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // Close all open socket.io connections
    if (typeof window !== 'undefined' && window.__agorClient) {
      const client = window.__agorClient;
      if (client?.io) {
        client.io.removeAllListeners();
        client.io.close();
      }
      delete window.__agorClient;
    }
  });
}

// Sign-in needs the daemon's /health config and the REST transport module.
// Request both before the first render queues the workspace's code chunks, so
// on a slow link sign-in (and the socket behind it) isn't stuck in that queue.
prefetchAuthConfig();
void preloadRestClientTransport().catch(() => {
  // createRestClient retries the import and surfaces the failure itself.
});

createRoot(document.getElementById('root')!).render(
  // Temporarily disable StrictMode to avoid double socket connections in dev
  // TODO: Make useAgorClient StrictMode-compatible by handling double-mount properly
  // <StrictMode>
  <App />
  // </StrictMode>
);
