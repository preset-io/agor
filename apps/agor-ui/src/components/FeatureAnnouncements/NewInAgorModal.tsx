import type {
  AgenticToolName,
  AgorClient,
  Branch,
  FeatureAnnouncementButton,
  FeatureAnnouncementClientItem,
  User,
} from '@agor-live/client';
import { ArrowRightOutlined, GiftOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import { Button, Flex, Modal, Tag, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectBranchById } from '../../store/selectors';
import { isMobileShellPath } from '../../utils/uiRoutes';
import { buildNewSessionConfig } from '../AgenticToolConfigurationPicker/newSessionConfig';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { resolveAvailableUserAgenticTool } from '../AgentSelectionGrid/availableAgents';
import { usePrimaryAssistantSend } from '../PrimaryAssistantCompose';
import { AnnouncementVisual } from './AnnouncementVisual';
import { useFeatureAnnouncements } from './FeatureAnnouncementsContext';
import { currentOrRecentBoardId, useOpenAgorPage } from './featureAnnouncementsActions';

export interface NewInAgorModalProps {
  client: AgorClient | null;
  user: User | null;
  /** Onboarding is open: the pop-up waits. */
  suppressed: boolean;
  authenticationGeneration?: number;
  isAuthenticationGenerationCurrent?: (generation: number) => boolean;
  onCreateSession?: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
}

const NO_ITEMS: FeatureAnnouncementClientItem[] = [];

/**
 * Starts a session with the user's primary teammate (else the board's) with the
 * announcement's message, through the same path as the navbar compose. With no
 * teammate it opens the teammates directory instead.
 */
const TeammateChatButton: React.FC<
  Omit<NewInAgorModalProps, 'suppressed'> & {
    button: Extract<FeatureAnnouncementButton, { action: 'teammate_chat' }>;
    onDone: () => void;
  }
> = ({ button, onDone, user, ...props }) => {
  const navigation = useAppNavigation();
  const boardById = useAgorStore(selectBoardById);
  const branchById = useAgorStore(selectBranchById);
  const boardId = currentOrRecentBoardId(user);
  const boardTeammateId = boardId ? boardById.get(boardId)?.primary_teammate_id : undefined;
  const compose = usePrimaryAssistantSend({
    ...props,
    currentUser: user,
    currentBoardId: boardId,
    buildConfig: (branch: Branch) =>
      buildNewSessionConfig({
        user,
        tool: resolveAvailableUserAgenticTool(
          user,
          agorStore.getState().agenticToolSettingsByName,
          AVAILABLE_AGENTS
        ) as AgenticToolName,
        branch,
        initialPrompt: button.message,
      }),
    canSend: () => agorStore.getState().agenticToolSettingsHydrated,
    onSent: onDone,
  });
  const teammate =
    compose.primaryBranch ?? (boardTeammateId ? branchById.get(boardTeammateId) : undefined);
  return (
    <Button
      type="primary"
      loading={compose.submitting !== null}
      disabled={compose.resolving}
      onClick={() => {
        if (teammate) {
          void compose.send('open', teammate);
        } else {
          onDone();
          navigation.goToTeammates();
        }
      }}
    >
      {button.label}
    </Button>
  );
};

/**
 * Big launches the user has not seen, newest first, one slide each. Each slide
 * is recorded as seen when it is displayed, and any way out marks every slide
 * seen, so the same launches never return (here, after a reload or in another tab).
 */
export const NewInAgorModal: React.FC<NewInAgorModalProps> = ({ suppressed, ...props }) => {
  const { token } = theme.useToken();
  const reduced = usePrefersReducedMotion();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const openAgorPage = useOpenAgorPage(props.user);
  const featureAnnouncements = useFeatureAnnouncements();
  const [index, setIndex] = useState(0);
  // Freeze the slides while open: marking them seen must not reshuffle the carousel.
  const [slides, setSlides] = useState<FeatureAnnouncementClientItem[]>(NO_ITEMS);
  const pending = featureAnnouncements?.feed.pending_popup_items ?? NO_ITEMS;
  const open = slides.length > 0;

  useEffect(() => {
    if (!open && !suppressed && pending.length > 0) {
      setIndex(0);
      setSlides(pending);
    }
  }, [open, suppressed, pending]);

  const slide = slides[index];
  const markPopupsSeen = featureAnnouncements?.markPopupsSeen;
  useEffect(() => {
    if (open && !suppressed && slide) markPopupsSeen?.([slide.id]);
  }, [open, suppressed, slide, markPopupsSeen]);

  if (!featureAnnouncements) return null;
  const many = slides.length > 1;
  const close = () => {
    featureAnnouncements.markPopupsSeen(slides.map((item) => item.id));
    setSlides(NO_ITEMS);
  };
  const go = (next: number) => setIndex(Math.max(0, Math.min(slides.length - 1, next)));

  const action = (button: FeatureAnnouncementButton) => {
    switch (button.action) {
      case 'agor_page':
        return (
          <Button
            type="primary"
            onClick={() => {
              close();
              openAgorPage(button.target);
            }}
          >
            {button.label}
          </Button>
        );
      case 'link':
        return (
          <Button
            type="primary"
            href={button.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
          >
            {button.label}
          </Button>
        );
      case 'teammate_chat':
        return <TeammateChatButton {...props} key={slide.id} button={button} onDone={close} />;
    }
  };

  return (
    <Modal
      open={open && !suppressed}
      onCancel={close}
      width={560}
      centered
      destroyOnHidden
      {...reducedMotionSurface(reduced)}
      footer={
        slide && (
          <Flex
            align="center"
            justify="space-between"
            gap={token.marginSM}
            wrap
            style={{
              marginTop: token.marginXS,
              paddingTop: token.padding,
              borderTop: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
            }}
          >
            <Button
              type="link"
              onClick={() => {
                close();
                // The mobile shell's bell lives on Home.
                if (isMobileShellPath(pathname)) navigate('/m');
                featureAnnouncements.openPopover('release-notes');
              }}
              style={{ paddingInline: 0, textDecoration: 'underline', textUnderlineOffset: 4 }}
            >
              All updates <ArrowRightOutlined />
            </Button>
            <Flex gap={token.marginXS} wrap>
              <Button onClick={close}>Not now</Button>
              {slide.button && action(slide.button)}
            </Flex>
          </Flex>
        )
      }
    >
      {slide && (
        <Flex
          vertical
          gap={token.marginXS}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') go(index + 1);
            if (event.key === 'ArrowLeft') go(index - 1);
          }}
        >
          <Tag
            icon={<GiftOutlined />}
            variant="filled"
            color="cyan"
            style={{ alignSelf: 'flex-start', borderRadius: token.borderRadiusLG }}
          >
            New in Agor
          </Tag>
          <Typography.Title level={3} style={{ margin: `${token.marginXS}px 0 0` }}>
            {slide.title}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeLG }}>
            {slide.one_line}
          </Typography.Text>
          {slide.visual && (
            <div style={{ marginTop: token.marginSM }}>
              <AnnouncementVisual key={slide.id} visual={slide.visual} alt={slide.visual_alt} />
            </div>
          )}
          {many && (
            <Flex
              align="center"
              justify="center"
              gap={token.marginSM}
              style={{ marginTop: token.marginXS }}
            >
              <Button
                type="text"
                size="small"
                aria-label="Previous"
                icon={<LeftOutlined />}
                disabled={index === 0}
                onClick={() => go(index - 1)}
              />
              <Flex gap={6} role="group" aria-label="Slides">
                {slides.map((item, i) => (
                  <Button
                    key={item.id}
                    type="text"
                    aria-label={`Slide ${i + 1} of ${slides.length}`}
                    aria-current={i === index ? 'true' : undefined}
                    onClick={() => go(i)}
                    style={{
                      width: i === index ? 22 : 8,
                      minWidth: 0,
                      height: 8,
                      padding: 0,
                      borderRadius: token.borderRadiusLG,
                      background: i === index ? token.colorPrimary : token.colorFillSecondary,
                      transition: reduced ? undefined : 'width 0.2s',
                    }}
                  />
                ))}
              </Flex>
              <Button
                type="text"
                size="small"
                aria-label="Next"
                icon={<RightOutlined />}
                disabled={index === slides.length - 1}
                onClick={() => go(index + 1)}
              />
            </Flex>
          )}
        </Flex>
      )}
    </Modal>
  );
};
