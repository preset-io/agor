import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installClipboardPolyfill } from './utils/clipboard-polyfill';
import { initializeHandlebarsHelpers } from './utils/handlebars-helpers';

// Install clipboard polyfill for non-HTTPS environments
// This ensures Streamdown's copy buttons work on HTTP and local network IPs
installClipboardPolyfill();

// Cleanup WebSocket connections on Vite HMR
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // Close all open socket.io connections
    // biome-ignore lint/suspicious/noExplicitAny: Global window extension for HMR cleanup
    if (typeof window !== 'undefined' && (window as any).__agorClient) {
      // biome-ignore lint/suspicious/noExplicitAny: Global window extension for HMR cleanup
      const client = (window as any).__agorClient;
      if (client?.io) {
        client.io.removeAllListeners();
        client.io.close();
      }
      // biome-ignore lint/suspicious/noExplicitAny: Global window extension for HMR cleanup
      delete (window as any).__agorClient;
    }
  });
}

// Initialize Handlebars helpers
initializeHandlebarsHelpers();

createRoot(document.getElementById('root')!).render(
  // Temporarily disable StrictMode to avoid double socket connections in dev
  // TODO: Make useAgorClient StrictMode-compatible by handling double-mount properly
  // <StrictMode>
  <App />
  // </StrictMode>
);
