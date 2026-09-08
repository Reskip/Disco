import type { DiscoClient } from '@disco-live/client';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installClipboardPolyfill } from './utils/clipboard-polyfill';
import { installVisualViewportSizing } from './utils/visualViewport';

declare global {
  interface Window {
    __discoClient?: DiscoClient;
  }
}

// Install clipboard polyfill for non-HTTPS environments
// This ensures Streamdown's copy buttons work on HTTP and local network IPs
installClipboardPolyfill();
installVisualViewportSizing();

// Cleanup WebSocket connections on Vite HMR
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // Close all open socket.io connections
    if (typeof window !== 'undefined' && window.__discoClient) {
      const client = window.__discoClient;
      if (client?.io) {
        client.io.removeAllListeners();
        client.io.close();
      }
      delete window.__discoClient;
    }
  });
}

createRoot(document.getElementById('root')!).render(
  // Temporarily disable StrictMode to avoid double socket connections in dev
  // TODO: Make useDiscoClient StrictMode-compatible by handling double-mount properly
  // <StrictMode>
  <App />
  // </StrictMode>
);
