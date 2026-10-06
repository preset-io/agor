import type { AgorClient, Branch, User } from '@agor-live/client';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { Button, ConfigProvider, Flex, Input, Select, Typography, theme } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { memo, useMemo, useRef, useState } from 'react';
import { useConnectionState } from '../../contexts/ConnectionContext';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useSessionAccess } from '../../hooks/useSessionAccess';
import { useSharedTeammates } from '../../hooks/useSharedTeammates';
import { agorStore, shallow, useAgorStore, useStoreWithEqualityFn } from '../../store/agorStore';
import { makeLatestOwnSessionSelector, makeTeammatesSelector } from '../../store/selectors';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { teammateEmoji, teammateLabel, teammateOption } from '../../utils/teammateLabels';
import { buildNewSessionConfig } from '../AgenticToolConfigurationPicker/newSessionConfig';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { resolveAvailableUserAgenticTool } from '../AgentSelectionGrid/availableAgents';
import {
  ComposeSendButtons,
  type ComposeSendMode,
  TeammateOptionLabel,
  usePrimaryAssistantSend,
} from '../PrimaryAssistantCompose';
import { PrimaryTeammatePicker } from '../SettingsModal/PrimaryTeammatePicker';
import { HomeList, HomePressable } from './HomeRow';
import { HomeCard, HomeLink, HomeSectionError, HomeSheet, useHomeCompact } from './HomeSection';
import { HOME_ASK_TARGET_MAX_WIDTH } from './homeLayout';

// Starters for new users only; returning users get the placeholder.
const NEW_USER_PROMPTS = [
  { label: 'What can you help me with?', short: 'What can you do?' },
  { label: 'Help me set up my first board', short: 'Set up a board' },
  { label: 'How do I talk to you from Slack?', short: 'Use Slack' },
];

const NO_TEAMMATES: Branch[] = [];
const noTeammates = () => NO_TEAMMATES;

/**
 * Who this message goes to. Lists only once opened: the primary, the caller's
 * own teammates, then shared ones whose access reaches `session`. Phones pick
 * from a bottom sheet; wider screens from a searchable dropdown.
 */
function AskTargetSelect({
  client,
  currentUser,
  primary,
  value,
  compact,
  onChange,
}: {
  client: AgorClient | null;
  currentUser?: User | null;
  primary: Branch | null;
  value: Branch | null;
  compact: boolean;
  onChange: (branch: Branch | null) => void;
}) {
  const { token } = theme.useToken();
  const [listed, setListed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const userId = currentUser?.user_id;
  const own = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => (listed ? makeTeammatesSelector(userId, 'own') : noTeammates), [listed, userId]),
    shallow
  );
  const {
    teammates: shared,
    settled: sharingSettled,
    failed: sharingFailed,
    retry: retrySharing,
    retrying: sharingRetrying,
  } = useSharedTeammates(client, listed ? currentUser : null);
  const {
    access,
    failedIds,
    failed: accessFailed,
    retry: retryAccess,
    retrying: accessRetrying,
  } = useSessionAccess(
    listed ? client : null,
    currentUser,
    shared.map((b) => b.branch_id)
  );
  const checking =
    !!client &&
    listed &&
    (!sharingSettled ||
      sharingRetrying ||
      accessRetrying ||
      shared.some((b) => !(b.branch_id in access) && !failedIds.has(b.branch_id)));
  const emptyText = checking
    ? 'Checking which teammates you can ask…'
    : sharingFailed + accessFailed > 0
      ? "Couldn't check access for some teammates. Reopen to try again"
      : 'No teammates you can ask';
  // Reads start on the first open; a later open retries the ones that failed.
  const openList = () => {
    setListed(true);
    if (sharingFailed > 0) retrySharing();
    if (accessFailed > 0) retryAccess();
  };
  const boardById = useAgorStore((s) => s.boardById);
  const repoById = useAgorStore((s) => s.repoById);
  const options = useMemo(() => {
    const seen = new Set<string>();
    return [primary, value, ...own, ...shared.filter((b) => access[b.branch_id])]
      .filter((b): b is Branch => !!b && !seen.has(b.branch_id) && !!seen.add(b.branch_id))
      .map((branch) => teammateOption(branch, boardById, repoById));
  }, [primary, value, own, shared, access, boardById, repoById]);
  const pick = (branch: Branch | null) => {
    setSheetOpen(false);
    onChange(branch);
  };
  const label = value ? `${teammateEmoji(value) ?? '🤖'} ${teammateLabel(value)}` : undefined;
  // A quieter border than the default, so the chip reads as clickable without competing with Send.
  const chipTheme = useMemo(
    () => ({
      components: {
        Button: { defaultBorderColor: token.colorBorderSecondary },
        Select: { colorBorder: token.colorBorderSecondary },
      },
    }),
    [token.colorBorderSecondary]
  );

  if (compact) {
    return (
      <>
        <ConfigProvider theme={chipTheme}>
          <Button
            aria-label={value ? `Teammate to ask: ${teammateLabel(value)}` : 'Pick an assistant'}
            icon={
              <DownOutlined
                style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary }}
              />
            }
            iconPlacement="end"
            onClick={() => {
              openList();
              setSheetOpen(true);
            }}
            styles={{ content: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }}
            style={{ flex: '0 1 auto', minWidth: 0, maxWidth: HOME_ASK_TARGET_MAX_WIDTH }}
          >
            {label ?? 'Pick an assistant'}
          </Button>
        </ConfigProvider>
        <HomeSheet open={sheetOpen} title="Ask" onClose={() => setSheetOpen(false)}>
          <HomeList
            items={options}
            itemKey={(option) => option.value}
            renderItem={(option) => (
              <HomePressable
                onOpen={() => pick(option.branch)}
                ariaLabel={option.label}
                align="center"
                style={{ minHeight: MOBILE_TOUCH_TARGET, paddingInline: token.paddingXS }}
              >
                <TeammateOptionLabel option={option} />
              </HomePressable>
            )}
          />
          {listed && options.length === 0 && (
            <Typography.Text type="secondary">{emptyText}</Typography.Text>
          )}
        </HomeSheet>
      </>
    );
  }
  return (
    <ConfigProvider theme={chipTheme}>
      <Select
        showSearch
        value={value?.branch_id}
        placeholder="Pick an assistant"
        aria-label="Teammate to ask"
        options={options}
        optionFilterProp="searchText"
        popupMatchSelectWidth={false}
        notFoundContent={emptyText}
        onOpenChange={(open) => open && openList()}
        onChange={(id) => pick(options.find((o) => o.value === id)?.branch ?? null)}
        labelRender={() => label}
        optionRender={({ data }) => <TeammateOptionLabel option={data} />}
        style={{ flex: '0 0 auto', maxWidth: HOME_ASK_TARGET_MAX_WIDTH }}
      />
    </ConfigProvider>
  );
}

interface HomeAskBoxProps {
  client: AgorClient | null;
  currentUser?: User | null;
  hasSessions: boolean;
  disabled?: boolean;
  onCreateSession: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
  onOpenSession: (sessionId: string) => void;
}

/** Home's quick compose: ask the primary assistant, or pick another teammate for one message. */
export const HomeAskBox = memo(function HomeAskBox({
  client,
  currentUser,
  hasSessions,
  disabled,
  onCreateSession,
  onOpenSession,
}: HomeAskBoxProps) {
  const { token } = theme.useToken();
  const compact = useHomeCompact();
  const { authGeneration } = useConnectionState();
  const inputRef = useRef<TextAreaRef>(null);
  const [prompt, setPrompt] = useState('');
  const [target, setTarget] = useState<Branch | null>(null);
  // What the in-flight send took, so its completion clears only a box still holding it.
  const sentRef = useRef<{ prompt: string; target: Branch | null } | null>(null);

  const compose = usePrimaryAssistantSend({
    client,
    currentUser,
    authenticationGeneration: authGeneration,
    onCreateSession,
    onOpenSession,
    // Also gates a held send resumed by a pick after the box was emptied.
    canSend: () => !disabled && prompt.trim().length > 0,
    buildConfig: (branch) => {
      sentRef.current = { prompt, target };
      return buildNewSessionConfig({
        user: currentUser,
        tool: resolveAvailableUserAgenticTool(
          currentUser,
          agorStore.getState().agenticToolSettingsByName,
          AVAILABLE_AGENTS
        ),
        branch,
        initialPrompt: prompt.trim(),
      });
    },
    onSent: () => {
      const sent = sentRef.current;
      sentRef.current = null;
      if (!sent) return;
      setPrompt((current) => (current === sent.prompt ? '' : current));
      setTarget((current) => (current === sent.target ? null : current));
    },
  });
  const primary = compose.primaryBranch;
  const assistant = target ?? primary;
  const name = assistant ? teammateLabel(assistant) : 'your primary assistant';
  const latest = useStoreWithEqualityFn(
    agorStore,
    useMemo(
      () => makeLatestOwnSessionSelector(primary?.branch_id, currentUser?.user_id),
      [primary?.branch_id, currentUser?.user_id]
    ),
    shallow
  );
  const busy =
    disabled ||
    compose.submitting !== null ||
    compose.resolving ||
    (!target && compose.resolveFailed);
  const focusInput = () => requestAnimationFrame(() => inputRef.current?.focus({ cursor: 'end' }));
  const send = (mode: ComposeSendMode) => {
    if (busy) return;
    if (!prompt.trim()) focusInput();
    else void compose.send(mode, target ?? undefined);
  };
  const suggest = (text: string) => {
    setPrompt(text);
    focusInput();
  };

  const continueLink = hasSessions && latest && !target && (
    <HomeLink
      size="middle"
      icon={<RightOutlined aria-hidden />}
      iconPlacement="end"
      onClick={() => onOpenSession(latest.sessionId)}
      styles={{ content: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }}
      style={{
        alignSelf: compact ? 'stretch' : 'flex-start',
        maxWidth: '100%',
        paddingInline: 0,
        justifyContent: 'space-between',
      }}
    >
      Continue “{latest.title}”
    </HomeLink>
  );

  // Composer layout: the input, one toolbar row whose controls share a height (32px, or
  // 44px on phones through HomeFrame's touch theme), then the continue row.
  return (
    <HomeCard padded>
      <Flex vertical gap={token.marginXS}>
        <Input.TextArea
          ref={inputRef}
          variant="borderless"
          autoSize={{ minRows: 1, maxRows: 6 }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            send(e.metaKey || e.ctrlKey ? 'open' : 'background');
          }}
          // The name before any comma keeps the placeholder on one line on phones.
          placeholder={`Ask ${name.split(',')[0]}…`}
          aria-label={`Ask ${name}`}
          style={{ fontSize: token.fontSizeLG, paddingInline: 0 }}
        />
        <Flex align="center" gap={token.marginXS} data-home-ask-toolbar>
          <AskTargetSelect
            client={client}
            currentUser={currentUser}
            primary={primary}
            value={assistant}
            compact={compact}
            onChange={(branch) =>
              setTarget(branch && branch.branch_id !== primary?.branch_id ? branch : null)
            }
          />
          <Flex gap={token.marginXS} style={{ flex: '0 0 auto', marginInlineStart: 'auto' }}>
            <ComposeSendButtons
              branch={assistant}
              submitting={compose.submitting}
              disabled={busy}
              compact={compact}
              onSend={send}
            />
          </Flex>
        </Flex>
        {continueLink}
        {!target && compose.resolveFailed && (
          <HomeSectionError
            message="Couldn’t load your primary assistant."
            onRetry={() => void compose.retryResolve()}
          />
        )}
        {!assistant && compose.pendingSend && !compose.resolving && (
          <Flex vertical gap={token.marginXS}>
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              You don't have a primary assistant yet. Pick one to send; you can change it anytime in
              Settings.
            </Typography.Text>
            <PrimaryTeammatePicker
              key={`${currentUser?.user_id ?? 'anonymous'}:${authGeneration}`}
              client={client}
              currentUserId={currentUser?.user_id}
              authenticationGeneration={authGeneration}
              compact
              disabled={disabled}
              onPicked={compose.pick}
            />
          </Flex>
        )}
        {!hasSessions && (
          <Flex align="center" gap={token.marginXS} wrap>
            {NEW_USER_PROMPTS.map((suggestion) => (
              <Button
                key={suggestion.label}
                shape="round"
                size="small"
                onClick={() => suggest(suggestion.label)}
              >
                {compact ? suggestion.short : suggestion.label}
              </Button>
            ))}
          </Flex>
        )}
      </Flex>
    </HomeCard>
  );
});
