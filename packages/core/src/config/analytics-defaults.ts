import type { AgorAnalyticsSettings } from './types.js';

export function getDefaultAnalyticsConfig(): AgorAnalyticsSettings {
  return {
    enabled: false,
    client: {
      app: 'agor-daemon',
      version: 'dev',
      debug: false,
    },
    filters: {
      exclude_events: [],
    },
    plugins: [
      {
        type: 'stdout',
        enabled: false,
        options: {
          pretty: false,
        },
      },
      {
        type: 'http_batch',
        enabled: false,
        options: {
          url: null,
          flush_interval_ms: 1000,
          max_batch_size: 50,
          timeout_ms: 3000,
          headers: {},
        },
      },
      {
        type: 'module',
        enabled: false,
        options: {
          module_path: null,
          export_name: 'createAnalyticsPlugin',
          plugin_options: {},
        },
      },
    ],
  };
}
