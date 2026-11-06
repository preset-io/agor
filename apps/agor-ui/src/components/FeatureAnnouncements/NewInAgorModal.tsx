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
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from '../../contexts/ThemeContext';
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
import { AnnouncementVisual, tint } from './AnnouncementVisual';
import { useFeatureAnnouncements } from './FeatureAnnouncementsContext';
import {
  canOpenAgorPage,
  currentOrRecentBoardId,
  useOpenAgorPage,
} from './featureAnnouncementsActions';

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
 * Every footer button, whatever its action or label: one height, padding and
 * line height, centred, and no primary drop shadow, so Not now and the primary
 * button sit level.
 */
const FOOTER_BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 36,
  paddingInline: 14,
  fontSize: 14.5,
  lineHeight: '20px',
  boxShadow: 'none',
};

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
      style={FOOTER_BUTTON}
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
  const { isDark } = useTheme();
  // The prototype's light teal for text on the dark surface; Agor teal on light.
  const accent = isDark ? token.colorPrimaryTextHover : token.colorPrimaryTextActive;
  const slideRef = useRef<HTMLDivElement>(null);
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  // Slides this carousel has displayed; they stay for the life of the pop-up.
  const shown = useRef(new Set<string>());

  useEffect(() => {
    if (!open && !suppressed && pending.length > 0) {
      shown.current = new Set();
      setIndex(0);
      setSlides(pending);
    }
  }, [open, suppressed, pending]);

  // Another tab may display a launch this carousel has not shown yet: once the
  // feed says it is seen, drop it. Slides shown here stay, so back and next keep
  // working and nothing moves under the reader.
  useEffect(() => {
    if (!open) return;
    const stillPending = new Set(pending.map((item) => item.id));
    setSlides((current) => {
      const kept = current.filter(
        (item, i) => i === index || shown.current.has(item.id) || stillPending.has(item.id)
      );
      return kept.length === current.length ? current : kept;
    });
  }, [open, pending, index]);

  const slide = slides[index];
  const markPopupsSeen = featureAnnouncements?.markPopupsSeen;
  useEffect(() => {
    if (!open || suppressed || !slide) return;
    shown.current.add(slide.id);
    markPopupsSeen?.([slide.id]);
  }, [open, suppressed, slide, markPopupsSeen]);

  if (!featureAnnouncements) return null;
  const many = slides.length > 1;
  const close = () => {
    featureAnnouncements.markPopupsSeen(slides.map((item) => item.id));
    setSlides(NO_ITEMS);
  };
  const go = (next: number) => {
    const target = Math.max(0, Math.min(slides.length - 1, next));
    setIndex(target);
    // Reaching either end disables the arrow just used, which would drop focus
    // to the page: hand it to the other arrow so focus and arrow keys stay here.
    const keep = target === 0 ? nextRef : target === slides.length - 1 ? previousRef : undefined;
    if (keep) window.setTimeout(() => keep.current?.focus());
  };

  const action = (button: FeatureAnnouncementButton) => {
    switch (button.action) {
      case 'agor_page':
        if (!canOpenAgorPage(button.target, props.user)) return null;
        return (
          <Button
            type="primary"
            style={FOOTER_BUTTON}
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
            style={FOOTER_BUTTON}
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
      width={520}
      centered
      destroyOnHidden
      // Focus the slide, not the close button, so no focus ring shows on open;
      // arrow keys still move between slides.
      afterOpenChange={(isOpen) => isOpen && slideRef.current?.focus()}
      styles={{
        container: {
          padding: `${token.paddingLG}px ${token.paddingLG}px 18px`,
          borderRadius: 16,
          border: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
        },
        footer: { marginTop: 0 },
      }}
      {...reducedMotionSurface(reduced)}
      footer={
        slide && (
          <Flex
            align="center"
            justify="space-between"
            gap={token.marginSM}
            wrap
            style={{
              marginTop: token.margin,
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
              style={{
                paddingInline: 0,
                color: accent,
                textDecoration: 'underline',
                textUnderlineOffset: 4,
              }}
            >
              All updates <ArrowRightOutlined />
            </Button>
            <Flex align="center" gap={token.marginXS} wrap>
              <Button style={FOOTER_BUTTON} onClick={close}>
                Not now
              </Button>
              {slide.button && action(slide.button)}
            </Flex>
          </Flex>
        )
      }
    >
      {slide && (
        <Flex
          vertical
          ref={slideRef}
          tabIndex={-1}
          style={{ outline: 'none' }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') go(index + 1);
            if (event.key === 'ArrowLeft') go(index - 1);
          }}
        >
          <Tag
            icon={<GiftOutlined />}
            variant="filled"
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              margin: 0,
              paddingInline: 10,
              borderRadius: 999,
              border: 'none',
              background: tint(token.colorPrimary, '2b'),
              color: accent,
              fontSize: token.fontSizeSM,
              fontWeight: 600,
            }}
          >
            New in Agor
          </Tag>
          <Typography.Title
            level={3}
            style={{ margin: '14px 0 0', fontSize: 22, lineHeight: 1.25, fontWeight: 650 }}
          >
            {slide.title}
          </Typography.Title>
          <Typography.Text
            style={{ marginTop: 6, fontSize: 14.5, color: token.colorTextSecondary }}
          >
            {slide.one_line}
          </Typography.Text>
          {slide.learn_more_url && (
            <Typography.Link
              href={slide.learn_more_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                alignSelf: 'flex-start',
                marginTop: 6,
                fontSize: token.fontSize - 1,
                color: accent,
              }}
            >
              Learn more <ArrowRightOutlined />
            </Typography.Link>
          )}
          {slide.visual && (
            <div style={{ marginTop: 20 }}>
              <AnnouncementVisual key={slide.id} visual={slide.visual} alt={slide.visual_alt} />
            </div>
          )}
          {many && (
            <Flex align="center" justify="center" gap={10} style={{ marginTop: 14 }}>
              <Button
                ref={previousRef}
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
                      background: i === index ? token.colorPrimary : token.colorFill,
                      transition: reduced ? undefined : 'width 0.2s',
                    }}
                  />
                ))}
              </Flex>
              <Button
                ref={nextRef}
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
