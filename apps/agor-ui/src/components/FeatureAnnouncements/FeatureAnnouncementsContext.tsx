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
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

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
  const [received, setReceived] = useState<FeatureAnnouncementsFeed | null>(null);
  // IDs this tab has shown or read. The server only ever adds seen IDs, so they
  // stay hidden for the provider's lifetime, whatever a response says.
  const [localSeen, setLocalSeen] = useState(() => ({
    popups: new Set<string>(),
    releases: new Set<string>(),
  }));
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [tab, setTab] = useState<FeatureAnnouncementsTab>('notifications');
  // Fetches and writes race: apply a response only if no later request's answer
  // has been applied, so a slow pre-dismissal fetch cannot reopen anything.
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  const userId = user?.user_id;
  // Another tab marking announcements seen arrives as a users patch; refetch on it.
  const seenKey = JSON.stringify(user?.preferences?.featureAnnouncements ?? null);
  const active = enabled && !!client && !!userId;

  const request = useCallback(
    (send: () => Promise<unknown>, isCurrent: () => boolean = () => true) => {
      const seq = ++requestSeq.current;
      send().then(
        (next) => {
          if (!isCurrent() || seq < appliedSeq.current) return;
          appliedSeq.current = seq;
          setReceived(next as FeatureAnnouncementsFeed);
        },
        // Announcements are never worth an error toast; keep what we have.
        () => {}
      );
    },
    []
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: seenKey and userId deliberately trigger a refetch
  useEffect(() => {
    if (!active || !client) {
      setReceived(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      request(
        () => client.service(FEATURE_ANNOUNCEMENTS_SERVICE).find(),
        () => !cancelled
      );
    load();
    const timer = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, client, userId, seenKey, request]);

  const markSeen = useCallback(
    (body: FeatureAnnouncementsMarkSeenRequest) => {
      if (client)
        request(() => client.service(FEATURE_ANNOUNCEMENTS_MARK_SEEN_SERVICE).create(body));
    },
    [client, request]
  );

  const feed = useMemo(
    () =>
      received && {
        ...received,
        announcements: received.announcements.map((release) =>
          localSeen.releases.has(release.id) ? { ...release, seen: true } : release
        ),
        unread_notification_ids: received.unread_notification_ids.filter(
          (id) => !localSeen.releases.has(id)
        ),
        pending_popup_items: received.pending_popup_items.filter(
          (item) => !localSeen.popups.has(item.id)
        ),
      },
    [received, localSeen]
  );

  const showTab = useCallback(
    (next: FeatureAnnouncementsTab) => {
      setTab(next);
      if (next !== 'release-notes' || !feed) return;
      // Opening Release notes reads every visible release, notification or not.
      const unseen = feed.announcements.filter((release) => !release.seen).map((r) => r.id);
      if (unseen.length === 0) return;
      setLocalSeen((current) => ({
        ...current,
        releases: new Set([...current.releases, ...unseen]),
      }));
      markSeen({ scope: 'release_notes' });
    },
    [feed, markSeen]
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
      const fresh = itemIds.filter((id) => !localSeen.popups.has(id));
      if (fresh.length === 0) return;
      setLocalSeen((current) => ({
        ...current,
        popups: new Set([...current.popups, ...fresh]),
      }));
      markSeen({ scope: 'popup', itemIds: fresh });
    },
    [localSeen, markSeen]
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
