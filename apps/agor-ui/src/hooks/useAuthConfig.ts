/**
 * useAuthConfig - Fetch daemon authentication and instance configuration
 *
 * Retrieves auth config and instance info from the daemon's health endpoint.
 * Used on app startup to determine if login page should be shown and display instance label.
 */

import { useEffect, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';

interface AuthConfig {
  requireAuth: boolean;
  allowAnonymous: boolean;
}

interface InstanceConfig {
  label?: string;
  description?: string;
}

interface SystemCredentials {
  ANTHROPIC_API_KEY?: boolean;
  OPENAI_API_KEY?: boolean;
  GEMINI_API_KEY?: boolean;
}

interface OnboardingConfig {
  persistedAgentPending?: boolean;
  frameworkRepoUrl?: string;
  systemCredentials?: SystemCredentials;
}

interface HealthResponse {
  status: string;
  timestamp: number;
  version: string;
  database: string;
  auth: AuthConfig;
  instance?: InstanceConfig;
  onboarding?: OnboardingConfig;
}

export function useAuthConfig() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [instanceConfig, setInstanceConfig] = useState<InstanceConfig | null>(null);
  const [onboardingConfig, setOnboardingConfig] = useState<OnboardingConfig | null>(null);
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
        setConfig(health.auth);
        setInstanceConfig(health.instance ?? null);
        setOnboardingConfig(health.onboarding ?? null);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        // Default to requiring auth on error (secure by default)
        setConfig({ requireAuth: true, allowAnonymous: false });
        setInstanceConfig(null);
        setOnboardingConfig(null);
      } finally {
        setLoading(false);
      }
    }

    fetchAuthConfig();
  }, []);

  return { config, instanceConfig, onboardingConfig, loading, error };
}
