import type {
  FeatureAnnouncementClientItem,
  FeatureAnnouncementClientRelease,
} from '@agor-live/client';
import {
  ArrowRightOutlined,
  BellOutlined,
  ExportOutlined,
  GiftOutlined,
  RightOutlined,
} from '@ant-design/icons';
import {
  Avatar,
  Badge,
  Button,
  Empty,
  Flex,
  Popover,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { type CSSProperties, useState } from 'react';
import { formatRelativeTime } from '../../utils/time';
import {
  type FeatureAnnouncementsTab,
  useFeatureAnnouncements,
} from './FeatureAnnouncementsContext';
import { ALL_RELEASE_NOTES_URL, formatReleaseDate } from './featureAnnouncementsActions';

/** Hugs its content up to this height, then scrolls. */
const BODY_MAX_HEIGHT = 'min(440px, 60vh)';

/** A full-width row on an AntD text button: its hover is a background change, never a reflow. */
const rowStyle = (padding: number): CSSProperties => ({
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'flex-start',
  width: '100%',
  height: 'auto',
  padding,
  textAlign: 'left',
  whiteSpace: 'normal',
  fontWeight: 'normal',
});

const pluralUpdates = (count: number) => `${count} ${count === 1 ? 'update' : 'updates'}`;

const isNew = (item: FeatureAnnouncementClientItem) => Date.parse(item.new_until) > Date.now();

const Dot: React.FC<{ on: boolean; size: number }> = ({ on, size }) => {
  const { token } = theme.useToken();
  return (
    <span
      aria-hidden
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: '50%',
        background: on ? token.colorPrimary : 'transparent',
      }}
    />
  );
};

const NotificationsList: React.FC<{ releases: FeatureAnnouncementClientRelease[] }> = ({
  releases,
}) => {
  const { token } = theme.useToken();
  const featureAnnouncements = useFeatureAnnouncements();
  if (!featureAnnouncements) return null;
  if (releases.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Nothing new right now"
        style={{ padding: token.paddingLG }}
      />
    );
  }
  const unread = new Set(featureAnnouncements.feed.unread_notification_ids);
  return (
    <Flex vertical style={{ padding: token.paddingXXS }}>
      {releases.map((release) => {
        const isUnread = unread.has(release.id);
        return (
          <Button
            key={release.id}
            type="text"
            onClick={() => featureAnnouncements.showTab('release-notes')}
            aria-label={`${isUnread ? 'Unread: ' : ''}New in Agor: ${pluralUpdates(release.items.length)}. See what's new in ${release.version_label}`}
            style={{ ...rowStyle(token.paddingSM), gap: token.marginSM }}
          >
            <Avatar
              shape="square"
              icon={<GiftOutlined />}
              style={{
                flexShrink: 0,
                background: token.colorPrimaryBg,
                color: token.colorPrimaryText,
              }}
            />
            <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Typography.Text strong type={isUnread ? undefined : 'secondary'}>
                New in Agor: {pluralUpdates(release.items.length)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                See what's new in {release.version_label}, released{' '}
                {formatReleaseDate(release.published_at)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM - 1 }}>
                {formatRelativeTime(release.published_at)}
              </Typography.Text>
            </Flex>
            <Flex align="center" gap={token.marginXS} style={{ paddingTop: token.paddingXXS }}>
              <Dot on={isUnread} size={8} />
              <RightOutlined
                style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}
              />
            </Flex>
          </Button>
        );
      })}
    </Flex>
  );
};

const ReleaseNoteRow: React.FC<{ item: FeatureAnnouncementClientItem; muted: boolean }> = ({
  item,
  muted,
}) => {
  const { token } = theme.useToken();
  // Learn more stays quiet until its row is hovered or focused; only its color changes.
  const [active, setActive] = useState(false);
  const body = (
    <Flex vertical gap={2} style={{ minWidth: 0 }}>
      <Flex align="center" gap={token.marginXS} style={{ marginBottom: 2 }}>
        {isNew(item) && <Dot on size={6} />}
        <Tag
          variant="filled"
          color={item.kind === 'new' ? 'cyan' : 'blue'}
          style={{ marginInlineEnd: 0, borderRadius: token.borderRadiusLG }}
        >
          {item.kind === 'new' ? 'New' : 'Improved'}
        </Tag>
      </Flex>
      <Typography.Text strong type={muted ? 'secondary' : undefined}>
        {item.title}
      </Typography.Text>
      <Typography.Paragraph
        type="secondary"
        ellipsis={{ rows: 2 }}
        style={{ margin: 0, fontSize: token.fontSizeSM }}
      >
        {item.one_line}
      </Typography.Paragraph>
      {item.learn_more_url && (
        <Typography.Text
          style={{
            fontSize: token.fontSizeSM,
            color: active ? token.colorPrimaryText : token.colorTextTertiary,
          }}
        >
          Learn more <ArrowRightOutlined />
        </Typography.Text>
      )}
    </Flex>
  );
  if (!item.learn_more_url) {
    return <div style={{ padding: token.paddingSM }}>{body}</div>;
  }
  return (
    <Button
      type="text"
      href={item.learn_more_url}
      target="_blank"
      rel="noopener noreferrer"
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      style={rowStyle(token.paddingSM)}
    >
      {body}
    </Button>
  );
};

const ReleaseNotes: React.FC<{ releases: FeatureAnnouncementClientRelease[] }> = ({ releases }) => {
  const { token } = theme.useToken();
  const [latest, ...earlier] = releases;
  const footer = (
    <div
      style={{
        padding: `${token.paddingSM}px ${token.padding}px`,
        borderTop: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Typography.Link href={ALL_RELEASE_NOTES_URL} target="_blank" rel="noopener noreferrer">
        All release notes <ExportOutlined />
      </Typography.Link>
    </div>
  );
  if (!latest) {
    return (
      <>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No release notes yet"
          style={{ padding: token.paddingLG }}
        />
        {footer}
      </>
    );
  }
  return (
    <>
      <div style={{ maxHeight: BODY_MAX_HEIGHT, overflowY: 'auto' }}>
        <Typography.Text
          type="secondary"
          style={{
            display: 'block',
            padding: `${token.paddingSM}px ${token.padding}px ${token.paddingXXS}px`,
            fontSize: token.fontSizeSM,
          }}
        >
          Latest: {latest.version_label}, {formatReleaseDate(latest.published_at)}
        </Typography.Text>
        <Flex vertical style={{ paddingInline: token.paddingXXS }}>
          {latest.items.map((item) => (
            <ReleaseNoteRow key={item.id} item={item} muted={false} />
          ))}
        </Flex>
        {earlier.length > 0 && (
          <>
            <Typography.Text
              type="secondary"
              strong
              style={{
                display: 'block',
                marginTop: token.marginXS,
                padding: `${token.paddingSM}px ${token.padding}px ${token.paddingXXS}px`,
                borderTop: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
                fontSize: token.fontSizeSM,
              }}
            >
              Earlier
            </Typography.Text>
            <Flex vertical style={{ paddingInline: token.paddingXXS }}>
              {earlier.flatMap((release) =>
                release.items.map((item) => <ReleaseNoteRow key={item.id} item={item} muted />)
              )}
            </Flex>
          </>
        )}
      </div>
      {footer}
    </>
  );
};

/**
 * The navbar bell: a popover with Notifications (one per release with new
 * features) and Release notes (the highlights). The badge counts unread
 * notifications; opening Release notes reads them.
 */
export const FeatureAnnouncementsBell: React.FC = () => {
  const { token } = theme.useToken();
  const featureAnnouncements = useFeatureAnnouncements();
  if (!featureAnnouncements) return null;
  const { feed, popoverOpen, tab } = featureAnnouncements;
  const unread = feed.unread_notification_ids.length;
  const notificationIds = new Set(feed.notification_ids);
  const notifications = feed.announcements.filter((release) => notificationIds.has(release.id));

  const content = (
    <Tabs
      activeKey={tab}
      onChange={(key) => featureAnnouncements.showTab(key as FeatureAnnouncementsTab)}
      size="small"
      tabBarStyle={{ margin: 0, paddingInline: token.padding }}
      items={[
        {
          key: 'notifications',
          label: (
            <Flex align="center" gap={token.marginXS}>
              Notifications
              <Badge
                count={unread}
                showZero
                size="small"
                style={
                  unread > 0
                    ? { background: token.colorPrimary }
                    : { background: token.colorFillSecondary, color: token.colorTextTertiary }
                }
              />
            </Flex>
          ),
          children: (
            <div style={{ maxHeight: BODY_MAX_HEIGHT, overflowY: 'auto' }}>
              <NotificationsList releases={notifications} />
            </div>
          ),
        },
        {
          key: 'release-notes',
          label: 'Release notes',
          children: <ReleaseNotes releases={feed.announcements} />,
        },
      ]}
    />
  );

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(open) =>
        open ? featureAnnouncements.openPopover() : featureAnnouncements.closePopover()
      }
      trigger="click"
      placement="bottomRight"
      content={content}
      styles={{ container: { padding: 0, width: 'min(360px, calc(100vw - 24px))' } }}
    >
      <Tooltip title={popoverOpen ? undefined : 'Notifications'}>
        <Button
          type="text"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          icon={
            <Badge count={unread} size="small" overflowCount={9}>
              <BellOutlined style={{ fontSize: token.fontSizeLG }} />
            </Badge>
          }
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        />
      </Tooltip>
    </Popover>
  );
};
