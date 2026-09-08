/**
 * useAuthConfig - Fetch daemon authentication and instance configuration
 *
 * Retrieves auth config and instance info from the daemon's health endpoint.
 * Used on app startup to determine if login page should be shown and display instance label.
 */

import type { UploadIngressPolicy } from '@disco/core/types';
import { useEffect, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';

interface AuthConfig {
  requireAuth: boolean;
}

interface InstanceConfig {
  label?: string;
  description?: string;
}

export interface FeaturesConfig {
  /**
   * True when the daemon enforces the local multi-user filesystem sandbox. The UI uses this to hide "trust everyone on this
   * instance" surfaces (e.g. the `instance` scope option in the artifact
   * consent modal). Server-side gates are the source of truth.
   */
  multiUser?: boolean;
  /** Experimental Cursor SDK provider enabled on the daemon. */
  cursorSdk?: boolean;
  /** Resolved upload limits enforced by the daemon. */
  uploadPolicy?: UploadIngressPolicy;
}

interface HealthResponse {
  status: string;
  timestamp: number;
  version: string;
  database: string;
  auth: AuthConfig;
  instance?: InstanceConfig;
  features?: FeaturesConfig;
}

export function useAuthConfig() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [instanceConfig, setInstanceConfig] = useState<InstanceConfig | null>(null);
  const [featuresConfig, setFeaturesConfig] = useState<FeaturesConfig | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function fetchAuthConfig() {
      try {
        const response = await fetch(`${getDaemonUrl()}/health`);
        if (!response.ok) {
          throw new Error(`Failed to fetch auth config: ${response.statusText}`);
        }

        const health: HealthResponse = await response.json();
        // Keep the browser-facing contract deliberately local-only. Legacy or
        // unknown external-login fields returned by an older daemon are not
        // retained in UI state.
        setConfig({ requireAuth: health.auth.requireAuth });
        setInstanceConfig(health.instance ?? null);
        setFeaturesConfig(health.features);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        // Default to requiring auth on error (secure by default)
        setConfig({ requireAuth: true });
        setInstanceConfig(null);
        setFeaturesConfig(undefined);
      } finally {
        setLoading(false);
      }
    }

    fetchAuthConfig();
  }, []);

  return {
    config,
    instanceConfig,
    featuresConfig,
    loading,
    error,
  };
}
