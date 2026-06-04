import type { AgorClient, Schedule } from '@agor-live/client';
import { useCallback, useEffect, useState } from 'react';

interface UseBranchSchedulesOptions {
  client: AgorClient | null;
  branchId: string | null;
  onError?: (message: string) => void;
}

export interface UseBranchSchedulesResult {
  schedules: Schedule[];
  loading: boolean;
  fetchSchedules: () => Promise<void>;
}

export function useBranchSchedules({
  client,
  branchId,
  onError,
}: UseBranchSchedulesOptions): UseBranchSchedulesResult {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchSchedules = useCallback(async () => {
    if (!client || !branchId) {
      setSchedules([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const result = await client.service('schedules').find({
        query: {
          branch_id: branchId,
          $sort: { created_at: -1 },
        },
      });
      setSchedules(Array.isArray(result) ? result : result.data);
    } catch (err) {
      console.error('Failed to load schedules:', err);
      onError?.('Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [client, branchId, onError]);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  // Live updates via Feathers events. The service emits these for every
  // CRUD op, including ones on other branches — filter to ours.
  useEffect(() => {
    if (!client || !branchId) return;
    const service = client.service('schedules');
    const matchesBranch = (s: Schedule) => s.branch_id === branchId;
    const onCreated = (s: Schedule) => {
      if (matchesBranch(s)) setSchedules((prev) => [s, ...prev]);
    };
    const onPatched = (s: Schedule) => {
      if (matchesBranch(s)) {
        setSchedules((prev) => prev.map((p) => (p.schedule_id === s.schedule_id ? s : p)));
      }
    };
    const onRemoved = (s: Schedule) => {
      if (matchesBranch(s)) {
        setSchedules((prev) => prev.filter((p) => p.schedule_id !== s.schedule_id));
      }
    };
    service.on('created', onCreated);
    service.on('patched', onPatched);
    service.on('removed', onRemoved);
    return () => {
      service.off('created', onCreated);
      service.off('patched', onPatched);
      service.off('removed', onRemoved);
    };
  }, [client, branchId]);

  return { schedules, loading, fetchSchedules };
}
