import { BellOutlined } from '@ant-design/icons';
import { Badge, Button, Tooltip, theme } from 'antd';
import { useReleaseNotes } from './ReleaseNotesContext';

/** Navbar entry to the notification center; the badge counts unread release notes. */
export const ReleaseNotesBell: React.FC = () => {
  const { token } = theme.useToken();
  const releaseNotes = useReleaseNotes();
  if (!releaseNotes) return null;
  const unread = releaseNotes.feed?.unread_note_ids.length ?? 0;
  const label = unread > 0 ? `What's new, ${unread} unread` : "What's new";
  return (
    <Tooltip title="What's new">
      <Button
        type="text"
        aria-label={label}
        onClick={releaseNotes.openDrawer}
        icon={
          <Badge count={unread} size="small" overflowCount={9}>
            <BellOutlined style={{ fontSize: token.fontSizeLG }} />
          </Badge>
        }
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      />
    </Tooltip>
  );
};
