import type { DaemonServicesConfig } from '@agor-live/client';
import { createContext } from 'react';

/**
 * ServicesConfigContext - Provides the daemon's resolved service tier configuration.
 *
 * Populated from the /health endpoint at startup. When undefined, all services
 * are treated as enabled (backward-compatible default).
 */
export const ServicesConfigContext = createContext<DaemonServicesConfig | undefined>(undefined);
