import type { DiscoAnalyticsSettings } from './types.js';

export function getDefaultAnalyticsConfig(): DiscoAnalyticsSettings {
  return {
    enabled: false,
    client: {
      app: 'disco-daemon',
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
    ],
  };
}
