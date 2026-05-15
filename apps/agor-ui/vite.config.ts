import path from 'node:path';
import { getDefaultConfig, loadConfigSync } from '@agor-live/client/config';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import viteCompression from 'vite-plugin-compression';

// Load Agor config to get daemon port
const agorConfig = (() => {
  try {
    return loadConfigSync();
  } catch {
    return getDefaultConfig();
  }
})();

const defaults = getDefaultConfig();
const daemonPort = agorConfig.daemon?.port || defaults.daemon?.port || 3030;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Pre-compress assets with gzip (works over HTTP and HTTPS)
    // Gzip: ~1MB compressed (vs 3.5MB uncompressed) - 70% reduction
    viteCompression({
      algorithm: 'gzip',
      ext: '.gz',
      threshold: 1024, // Only compress files > 1KB
      deleteOriginFile: false, // Keep originals for fallback
    }),
  ],

  // Polyfill Node.js globals for browser compatibility
  define: {
    global: 'globalThis',
    // Inject daemon port from config.yaml (allows frontend to respect config)
    'import.meta.env.VITE_DAEMON_PORT': String(daemonPort),
  },

  // Set base path for production builds (served from /ui by daemon)
  // In development, this is ignored (uses default /)
  base: process.env.NODE_ENV === 'production' ? '/ui/' : '/',

  // Path alias resolution
  resolve: {
    conditions: ['source'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Mark Node.js-only packages as external so they're not bundled
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      external: ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk', '@google/gemini-cli-core'],
      output: {
        // Coarse manual chunking so heavy single-use libs don't land in the
        // initial bundle. Tune as the app's hot path stabilizes; the goal
        // here is "warn if a chunk crosses ~1MB" not perfect split.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@ant-design') || /\/antd\//.test(id)) return 'antd';
          if (id.includes('reactflow')) return 'reactflow';
          if (id.includes('@uiw/react-codemirror') || id.includes('@codemirror/')) return 'editor';
          if (id.includes('react-syntax-highlighter')) return 'syntax';
          if (id.includes('emoji-picker-react') || id.includes('emojibase')) return 'emoji';
          if (id.includes('@tsparticles/')) return 'particles';
          if (id.includes('@xterm/')) return 'xterm';
          if (id.includes('@codesandbox/sandpack')) return 'sandpack';
          return undefined;
        },
      },
    },
  },

  server: {
    // Bind to 0.0.0.0 for Docker accessibility
    host: '0.0.0.0',
    port: 5173,
    // Watch for changes in workspace packages
    watch: {
      // Watch the @agor-live/client package for changes
      ignored: ['!**/node_modules/@agor-live/client/**'],
    },
    fs: {
      // Allow serving files from the monorepo root
      allow: ['../..'],
    },
  },
});
