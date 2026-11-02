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

/** Cloud announcements refresh on the daemon every 15 minutes; follow at the same pace. */
const REFRESH_INTERVAL_MS = 15 * 60_000;

export type FeatureAnnouncementsTab = 'notifications' | 'release-notes';

/** Settings the App shell owns; buttons open them through these. */
export interface FeatureAnnouncementsShell {
  openWorkspaceSettings: (section: 'gateway' | 'artifacts') => void;
  openModelSettings: () => void;
}

interface FeatureAnnouncementsController {
  feed: FeatureAnnouncementsFeed;
  shell: FeatureAnnouncementsShell;
  /** The bell popover; one per shell, so its state lives here for the pop-up's "All updates". */
  popoverOpen: boolean;
  tab: FeatureAnnouncementsTab;
  /** Opens the popover; Release notes counts as reading every notification. */
  openPopover: (tab?: FeatureAnnouncementsTab) => void;
  closePopover: () => void;
  showTab: (tab: FeatureAnnouncementsTab) => void;
  markPopupsSeen: (itemIds: string[]) => void;
}

const FeatureAnnouncementsContext = createContext<FeatureAnnouncementsController | null>(null);

/** Null outside the provider, when announcements are off, or before the source first answers. */
export const useFeatureAnnouncements = () => useContext(FeatureAnnouncementsContext);

export function FeatureAnnouncementsProvider({
  client,
  user,
  enabled,
  shell,
  children,
}: {
  client: AgorClient | null;
  user: User | null;
  enabled: boolean;
  shell: FeatureAnnouncementsShell;
  children: React.ReactNode;
}) {
  const [feed, setFeed] = useState<FeatureAnnouncementsFeed | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [tab, setTab] = useState<FeatureAnnouncementsTab>('notifications');
  const userId = user?.user_id;
  // Another tab marking announcements seen arrives as a users patch; refetch on it.
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
        // Announcements are never worth an error toast; keep what we have.
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

  const hasUnread = (feed?.unread_notification_ids.length ?? 0) > 0;
  const showTab = useCallback(
    (next: FeatureAnnouncementsTab) => {
      setTab(next);
      if (next === 'release-notes' && hasUnread) markSeen({ scope: 'release_notes' });
    },
    [hasUnread, markSeen]
  );
  const openPopover = useCallback(
    (next: FeatureAnnouncementsTab = 'notifications') => {
      showTab(next);
      setPopoverOpen(true);
    },
    [showTab]
  );
  const closePopover = useCallback(() => setPopoverOpen(false), []);
  const markPopupsSeen = useCallback(
    (itemIds: string[]) => {
      if (itemIds.length === 0) return;
      // Optimistic, so the pop-up cannot reappear while the write is in flight.
      setFeed(
        (current) =>
          current && {
            ...current,
            pending_popup_items: current.pending_popup_items.filter(
              (item) => !itemIds.includes(item.id)
            ),
          }
      );
      markSeen({ scope: 'popup', itemIds });
    },
    [markSeen]
  );

  // Nothing renders until the source has answered once, so a Cloud cell that
  // ships before its feature-announcements endpoint shows no bell at all.
  const value = useMemo(
    () =>
      active && feed?.available
        ? {
            feed,
            shell,
            popoverOpen,
            tab,
            openPopover,
            closePopover,
            showTab,
            markPopupsSeen,
          }
        : null,
    [active, feed, shell, popoverOpen, tab, openPopover, closePopover, showTab, markPopupsSeen]
  );
  return (
    <FeatureAnnouncementsContext.Provider value={value}>
      {children}
    </FeatureAnnouncementsContext.Provider>
  );
}
