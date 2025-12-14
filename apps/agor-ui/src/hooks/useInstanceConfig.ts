/**
 * useInstanceConfig - Fetch instance configuration (label, description)
 *
 * Retrieves instance identification settings from daemon config.
 * Used to display the instance label in the navbar.
 */

import { useEffect, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';

interface InstanceConfig {
  instanceLabel?: string;
  instanceDescription?: string;
}

export function useInstanceConfig() {
  const [config, setConfig] = useState<InstanceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function fetchInstanceConfig() {
      try {
        const response = await fetch(`${getDaemonUrl()}/config/daemon`);
        if (!response.ok) {
          throw new Error(`Failed to fetch instance config: ${response.statusText}`);
        }

        const daemonConfig = await response.json();
        setConfig({
          instanceLabel: daemonConfig?.instanceLabel,
          instanceDescription: daemonConfig?.instanceDescription,
        });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setConfig(null);
      } finally {
        setLoading(false);
      }
    }

    fetchInstanceConfig();
  }, []);

  return { config, loading, error };
}
