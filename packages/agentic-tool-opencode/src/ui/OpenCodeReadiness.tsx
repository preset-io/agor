import type { AgorClient } from '@agor/core/client';
import type { ReactNode } from 'react';
import { useOpenCodeModelCatalog } from './useOpenCodeModelCatalog.js';

type OpenCodeReadinessValue = {
  tone: 'positive' | 'neutral';
  label: string;
};

export function OpenCodeReadiness({
  client,
  canLoadReadiness = true,
  children,
}: {
  client?: AgorClient | null;
  canLoadReadiness?: boolean;
  children: (status: OpenCodeReadinessValue) => ReactNode;
}) {
  const { catalog, availabilityResolved, refreshFailed } = useOpenCodeModelCatalog({
    client,
    catalogEnabled: canLoadReadiness,
  });

  let status: OpenCodeReadinessValue;
  if (!canLoadReadiness || !client || refreshFailed) {
    status = { tone: 'neutral', label: 'Status unavailable' };
  } else if (!availabilityResolved) {
    status = { tone: 'neutral', label: 'Checking availability' };
  } else if (!Array.isArray(catalog?.providers)) {
    status = { tone: 'neutral', label: 'Status unavailable' };
  } else if (catalog.providers.some((provider) => provider.availableForSelection)) {
    status = { tone: 'positive', label: 'Available' };
  } else {
    status = { tone: 'neutral', label: 'Not available' };
  }

  return children(status);
}
