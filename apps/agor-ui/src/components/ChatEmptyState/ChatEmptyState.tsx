import type { AgorClient, Branch, User } from '@agor-live/client';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Empty, Flex, Input, Spin, Typography, theme } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { useRef, useState } from 'react';
import { useConnectionState } from '../../contexts/ConnectionContext';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useIsTouchInput } from '../../hooks/useCanHover';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { isComposerSendKey } from '../../utils/composerKeys';
import { firstNameOf } from '../../utils/firstName';
import { NEW_USER_PROMPTS } from '../../utils/starterPrompts';
import { DEFAULT_TEAMMATE_EMOJI, teammateEmoji, teammateLabel } from '../../utils/teammateLabels';
import { buildNewSessionConfig } from '../AgenticToolConfigurationPicker/newSessionConfig';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { resolveAvailableUserAgenticTool } from '../AgentSelectionGrid/availableAgents';
import {
  ComposeSendButtons,
  type ComposeSendMode,
  usePrimaryAssistantSend,
} from '../PrimaryAssistantCompose';

const CONTENT_MAX_WIDTH = 640;

interface ChatEmptyStateProps {
  client: AgorClient | null;
  currentUser?: User | null;
  /** The board's primary teammate, once loaded. */
  teammate: Branch | null;
  /** The board names a primary teammate that is still loading. */
  teammateLoading: boolean;
  /** The board names a primary teammate this person cannot see. */
  teammateInaccessible: boolean;
  /** Absent for people who cannot start sessions: the composer is disabled. */
  onCreateSession?: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
  onOpenSession: (sessionId: string) => void;
  /** Editors on a board without a primary teammate. */
  onCreateTeammate?: () => void;
}

/** The board's Chat tab with no conversation open. */
export const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({
  client,
  currentUser,
  teammate,
  teammateLoading,
  teammateInaccessible,
  onCreateSession,
  onOpenSession,
  onCreateTeammate,
}) => {
  const { token } = theme.useToken();
  const touchInput = useIsTouchInput();
  const { authGeneration } = useConnectionState();
  const settingsHydrated = useAgorStore((s) => s.agenticToolSettingsHydrated);
  const inputRef = useRef<TextAreaRef>(null);
  const [prompt, setPrompt] = useState('');
  const sentPromptRef = useRef<string | null>(null);
  const disabled = !onCreateSession;

  const compose = usePrimaryAssistantSend({
    client,
    currentUser,
    authenticationGeneration: authGeneration,
    onCreateSession,
    onOpenSession,
    canSend: () =>
      !disabled && agorStore.getState().agenticToolSettingsHydrated && prompt.trim().length > 0,
    buildConfig: (branch) => {
      sentPromptRef.current = prompt;
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
      const sent = sentPromptRef.current;
      sentPromptRef.current = null;
      setPrompt((current) => (current === sent ? '' : current));
    },
  });

  const centered = (children: React.ReactNode) => (
    <Flex
      vertical
      align="center"
      justify="center"
      style={{ height: '100%', padding: token.paddingLG, background: token.colorBgContainer }}
    >
      {children}
    </Flex>
  );

  if (!teammate) {
    if (teammateLoading) return centered(<Spin />);
    return centered(
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Typography.Text type="secondary">
            {teammateInaccessible
              ? "This board's teammate isn't available. It may have been deleted, or you may not have access."
              : "This board doesn't have a primary teammate yet."}
          </Typography.Text>
        }
      >
        {onCreateTeammate && !teammateInaccessible && (
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreateTeammate}>
            Create AI teammate
          </Button>
        )}
      </Empty>
    );
  }

  const name = teammateLabel(teammate);
  const busy = disabled || !settingsHydrated || compose.submitting !== null;
  const focusInput = () => requestAnimationFrame(() => inputRef.current?.focus({ cursor: 'end' }));
  const send = (mode: ComposeSendMode) => {
    if (busy) return;
    if (!prompt.trim()) focusInput();
    else void compose.send(mode, teammate);
  };

  return centered(
    <Flex vertical gap={token.marginLG} style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
      <Flex vertical align="center" gap={token.marginSM}>
        <span aria-hidden style={{ fontSize: 40, lineHeight: 1 }}>
          {teammateEmoji(teammate) ?? DEFAULT_TEAMMATE_EMOJI}
        </span>
        <Typography.Title level={3} style={{ margin: 0, textAlign: 'center' }}>
          Hi {firstNameOf(currentUser)}, I’m {name}
        </Typography.Title>
      </Flex>
      <Flex
        vertical
        gap={token.marginXS}
        style={{
          padding: token.paddingSM,
          border: `1px solid ${token.colorBorder}`,
          borderRadius: token.borderRadiusLG,
          background: token.colorBgContainer,
        }}
      >
        <Input.TextArea
          ref={inputRef}
          variant="borderless"
          autoSize={{ minRows: 2, maxRows: 8 }}
          value={prompt}
          disabled={disabled}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (!isComposerSendKey(event, touchInput)) return;
            event.preventDefault();
            send('open');
          }}
          placeholder={`Message ${name}…`}
          aria-label={`Message ${name}`}
          style={{ fontSize: token.fontSizeLG }}
        />
        <Flex justify="flex-end" gap={token.marginXS}>
          <ComposeSendButtons
            branch={teammate}
            submitting={compose.submitting}
            disabled={busy}
            onSend={send}
          />
        </Flex>
      </Flex>
      <Flex justify="center" gap={token.marginXS} wrap>
        {NEW_USER_PROMPTS.map((suggestion) => (
          <Button
            key={suggestion.label}
            shape="round"
            size="small"
            disabled={disabled}
            onClick={() => {
              setPrompt(suggestion.label);
              focusInput();
            }}
          >
            {suggestion.label}
          </Button>
        ))}
      </Flex>
    </Flex>
  );
};
