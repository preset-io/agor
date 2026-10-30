import type {
  AgenticToolName,
  AgorClient,
  Branch,
  FeatureAnnouncementDTO,
  FeatureAnnouncementItemDTO,
  User,
} from '@agor-live/client';
import { RobotOutlined } from '@ant-design/icons';
import { Button, Drawer, Empty, Flex, Tag, Typography, theme } from 'antd';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectBranchById } from '../../store/selectors';
import { teammateEmoji, teammateLabel } from '../../utils/teammateLabels';
import { buildNewSessionConfig } from '../AgenticToolConfigurationPicker/newSessionConfig';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { resolveAvailableUserAgenticTool } from '../AgentSelectionGrid/availableAgents';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { usePrimaryAssistantSend } from '../PrimaryAssistantCompose';
import { useFeatureAnnouncements } from './FeatureAnnouncementsContext';
import {
  buildAskTeammatePrompt,
  currentOrRecentBoardId,
  resolveCtaPath,
} from './featureAnnouncementsLinks';

const CATEGORY_LABELS: Record<FeatureAnnouncementItemDTO['category'], string> = {
  feature: 'Feature',
  improvement: 'Improvement',
  fix: 'Fix',
  security: 'Security',
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** Notes sharing a publication day render under one date heading. */
function groupByDay(notes: FeatureAnnouncementDTO[]): Array<[string, FeatureAnnouncementDTO[]]> {
  const groups = new Map<string, FeatureAnnouncementDTO[]>();
  for (const note of notes) {
    const day = note.published_at.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), note]);
  }
  return [...groups];
}

export interface FeatureAnnouncementsDrawerProps {
  client: AgorClient | null;
  user: User | null;
  authenticationGeneration?: number;
  isAuthenticationGenerationCurrent?: (generation: number) => boolean;
  onCreateSession?: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
}

/**
 * Asks a teammate to review recent updates against the user's work.
 * Uses the user's primary assistant, else the current board's primary teammate.
 */
const AskTeammate: React.FC<
  FeatureAnnouncementsDrawerProps & { notes: FeatureAnnouncementDTO[] }
> = ({
  client,
  user,
  authenticationGeneration,
  isAuthenticationGenerationCurrent,
  onCreateSession,
  notes,
}) => {
  const { token } = theme.useToken();
  const navigation = useAppNavigation();
  const featureAnnouncements = useFeatureAnnouncements();
  const boardById = useAgorStore(selectBoardById);
  const branchById = useAgorStore(selectBranchById);
  const settingsHydrated = useAgorStore((state) => state.agenticToolSettingsHydrated);
  const boardId = currentOrRecentBoardId(user);
  const boardTeammateId = boardId ? boardById.get(boardId)?.primary_teammate_id : undefined;
  const boardTeammate = boardTeammateId ? branchById.get(boardTeammateId) : undefined;

  const compose = usePrimaryAssistantSend({
    client,
    currentUser: user,
    authenticationGeneration,
    isAuthenticationGenerationCurrent,
    currentBoardId: boardId,
    onCreateSession,
    buildConfig: (branch: Branch) =>
      buildNewSessionConfig({
        user,
        tool: resolveAvailableUserAgenticTool(
          user,
          agorStore.getState().agenticToolSettingsByName,
          AVAILABLE_AGENTS
        ) as AgenticToolName,
        branch,
        initialPrompt: buildAskTeammatePrompt(notes),
      }),
    canSend: () => agorStore.getState().agenticToolSettingsHydrated,
    onSent: () => featureAnnouncements?.closeDrawer(),
  });
  const teammate = compose.primaryBranch ?? boardTeammate ?? null;

  if (!teammate) {
    if (compose.resolving) return null;
    return (
      <Typography.Text type="secondary">
        Want a teammate to check which updates help you?{' '}
        <Typography.Link
          onClick={() => {
            featureAnnouncements?.closeDrawer();
            navigation.goToTeammates();
          }}
        >
          Set up a teammate
        </Typography.Link>
      </Typography.Text>
    );
  }
  const emoji = teammateEmoji(teammate);
  return (
    <Flex
      align="center"
      justify="space-between"
      gap={token.marginSM}
      style={{
        padding: token.paddingSM,
        background: token.colorFillQuaternary,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
      }}
    >
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        {teammateLabel(teammate)} can look at your boards and recent work and tell you which updates
        help.
      </Typography.Text>
      <Button
        icon={emoji ? <span aria-hidden>{emoji}</span> : <RobotOutlined />}
        loading={compose.submitting !== null}
        disabled={!settingsHydrated || notes.length === 0}
        onClick={() => void compose.send('open', teammate)}
      >
        Ask my teammate
      </Button>
    </Flex>
  );
};

const NoteItem: React.FC<{ item: FeatureAnnouncementItemDTO; user: User | null }> = ({
  item,
  user,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const featureAnnouncements = useFeatureAnnouncements();
  const ctaPath = item.cta_label ? resolveCtaPath(item.cta_path, user) : null;
  return (
    <Flex vertical gap={token.marginXXS}>
      <Flex align="center" gap={token.marginXS} wrap>
        <Typography.Text strong>{item.title}</Typography.Text>
        <Tag variant="filled">{CATEGORY_LABELS[item.category]}</Tag>
      </Flex>
      <MarkdownRenderer content={item.body_md} />
      {(item.docs_url || ctaPath) && (
        <Flex gap={token.marginSM}>
          {ctaPath && (
            <Typography.Link
              onClick={() => {
                featureAnnouncements?.closeDrawer();
                navigate(ctaPath);
              }}
            >
              {item.cta_label}
            </Typography.Link>
          )}
          {item.docs_url && (
            <Typography.Link href={item.docs_url} target="_blank" rel="noopener noreferrer">
              Read the docs
            </Typography.Link>
          )}
        </Flex>
      )}
    </Flex>
  );
};

/** The notification center: every feature announcement the caller can see, newest first. */
export const FeatureAnnouncementsDrawer: React.FC<FeatureAnnouncementsDrawerProps> = (props) => {
  const { token } = theme.useToken();
  const featureAnnouncements = useFeatureAnnouncements();
  const notes = featureAnnouncements?.feed?.notes ?? [];
  const groups = useMemo(() => groupByDay(notes), [notes]);
  if (!featureAnnouncements) return null;

  return (
    <Drawer
      title="What's new"
      placement="right"
      size={440}
      open={featureAnnouncements.drawerOpen}
      onClose={featureAnnouncements.closeDrawer}
      destroyOnHidden
    >
      <Flex vertical gap={token.marginLG}>
        <AskTeammate {...props} notes={notes} />
        {groups.length === 0 ? (
          <Empty description="No updates yet" />
        ) : (
          groups.map(([day, dayNotes]) => (
            <Flex key={day} vertical gap={token.margin}>
              <Flex align="center" gap={token.marginXS}>
                <Typography.Title level={5} style={{ margin: 0 }}>
                  {formatDate(dayNotes[0].published_at)}
                </Typography.Title>
                <Typography.Text type="secondary">
                  {dayNotes.map((note) => note.title).join(', ')}
                </Typography.Text>
                {dayNotes.some((note) => featureAnnouncements.newNoteIds.has(note.id)) && (
                  <Tag color="blue" variant="filled">
                    New
                  </Tag>
                )}
              </Flex>
              {dayNotes.flatMap((note) =>
                note.items.map((item) => <NoteItem key={item.id} item={item} user={props.user} />)
              )}
            </Flex>
          ))
        )}
      </Flex>
    </Drawer>
  );
};
