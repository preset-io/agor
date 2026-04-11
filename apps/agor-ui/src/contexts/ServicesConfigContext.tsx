import type { DaemonServicesConfig } from '@agor/core/types';
import { createContext } from 'react';

/**
 * ServicesConfigContext - Provides the daemon's resolved service tier configuration.
 *
 * Populated from the /health endpoint at startup. When undefined, all services
 * are treated as enabled (backward-compatible default).
 */
export const ServicesConfigContext = createContext<DaemonServicesConfig | undefined>(undefined);
