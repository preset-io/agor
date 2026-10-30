import type {
  AgorClient,
  FeatureAnnouncementsFeed,
  FeatureAnnouncementsMarkSeenRequest,
  User,
} from '@agor-live/client';
import {
  FEATURE_ANNOUNCEMENTS_MARK_SEEN_SERVICE,
  FEATURE_ANNOUNCEMENTS_SERVICE,
} from '@agor-live/client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/** Cloud notes refresh on the daemon every 15 minutes; follow at the same pace. */
const REFRESH_INTERVAL_MS = 15 * 60_000;

interface FeatureAnnouncementsController {
  feed: FeatureAnnouncementsFeed | null;
  drawerOpen: boolean;
  /** Notes that were unread when the drawer was opened, so they can stay marked as new. */
  newNoteIds: ReadonlySet<string>;
  /** Opens the drawer and records that the caller has seen everything in it. */
  openDrawer: () => void;
  closeDrawer: () => void;
  markMajorsSeen: (itemIds: string[]) => void;
}

const FeatureAnnouncementsContext = createContext<FeatureAnnouncementsController | null>(null);

/** Null outside the provider, when feature announcements are off, or before the source first answers. */
export const useFeatureAnnouncements = () => useContext(FeatureAnnouncementsContext);

export function FeatureAnnouncementsProvider({
  client,
  user,
  enabled,
  children,
}: {
  client: AgorClient | null;
  user: User | null;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [feed, setFeed] = useState<FeatureAnnouncementsFeed | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newNoteIds, setNewNoteIds] = useState<ReadonlySet<string>>(new Set());
  const userId = user?.user_id;
  // Another tab marking notes seen arrives as a users patch; refetch on it.
  const seenKey = JSON.stringify(user?.preferences?.featureAnnouncements ?? null);
  const active = enabled && !!client && !!userId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: seenKey and userId deliberately trigger a refetch
  useEffect(() => {
    if (!active || !client) {
      setFeed(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      (
        client
          .service(FEATURE_ANNOUNCEMENTS_SERVICE)
          .find() as unknown as Promise<FeatureAnnouncementsFeed>
      ).then(
        (next) => {
          if (!cancelled) setFeed(next);
        },
        // Feature announcements are never worth an error toast; keep what we have.
        () => {}
      );
    void load();
    const timer = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, client, userId, seenKey]);

  const markSeen = useCallback(
    (request: FeatureAnnouncementsMarkSeenRequest) => {
      if (!client) return;
      client
        .service(FEATURE_ANNOUNCEMENTS_MARK_SEEN_SERVICE)
        .create(request)
        .then(
          (next) => setFeed(next as FeatureAnnouncementsFeed),
          () => {}
        );
    },
    [client]
  );

  const openDrawer = useCallback(() => {
    setNewNoteIds(new Set(feed?.unread_note_ids));
    setDrawerOpen(true);
    markSeen({ scope: 'drawer' });
  }, [feed, markSeen]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const markMajorsSeen = useCallback(
    (itemIds: string[]) => {
      if (itemIds.length === 0) return;
      // Optimistic, so the modal cannot reappear while the write is in flight.
      setFeed(
        (current) =>
          current && {
            ...current,
            pending_major_items: current.pending_major_items.filter(
              (item) => !itemIds.includes(item.id)
            ),
          }
      );
      markSeen({ scope: 'major', itemIds });
    },
    [markSeen]
  );

  // Nothing renders until the source has answered once, so a Cloud cell that
  // ships before its feature-announcements endpoint shows no bell and no empty drawer.
  const shown = active && !!feed?.available;
  const value = useMemo(
    () =>
      shown ? { feed, drawerOpen, newNoteIds, openDrawer, closeDrawer, markMajorsSeen } : null,
    [shown, feed, drawerOpen, newNoteIds, openDrawer, closeDrawer, markMajorsSeen]
  );
  return (
    <FeatureAnnouncementsContext.Provider value={value}>
      {children}
    </FeatureAnnouncementsContext.Provider>
  );
}
