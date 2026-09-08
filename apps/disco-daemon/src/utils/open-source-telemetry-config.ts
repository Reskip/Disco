import type { DiscoConfig } from '@disco/core/config';
import { generateTelemetryInstanceId, isTelemetryEnabledByEnv } from '@disco/core/telemetry';

export function ensureOpenSourceTelemetryEnvEnabledConfig(
  config: DiscoConfig,
  env: NodeJS.ProcessEnv = process.env,
  generateInstanceId: () => string = generateTelemetryInstanceId
): { config: DiscoConfig; changed: boolean } {
  if (!isTelemetryEnabledByEnv(env) || config.telemetry?.instance_id) {
    return { config, changed: false };
  }

  return {
    config: {
      ...config,
      telemetry: {
        ...config.telemetry,
        enabled: true,
        instance_id: generateInstanceId(),
      },
    },
    changed: true,
  };
}
