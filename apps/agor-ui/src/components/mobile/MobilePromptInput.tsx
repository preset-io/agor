import type { AgorClient, SessionID, User } from '@agor-live/client';
import { SendOutlined } from '@ant-design/icons';
import { Button, theme } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { deletePromptDraft, getPromptDraft, savePromptDraft } from '../../utils/promptDrafts';
import { AutocompleteTextarea } from '../AutocompleteTextarea';

interface MobilePromptInputProps {
  onSend: (prompt: string) => boolean | undefined | Promise<boolean | undefined>;
  disabled?: boolean;
  placeholder?: string;
  currentUserId?: string;
  client: AgorClient | null;
  sessionId: SessionID | null;
  userById: Map<string, User>;
}

export const MobilePromptInput: React.FC<MobilePromptInputProps> = ({
  onSend,
  disabled = false,
  placeholder = 'Send a prompt...',
  currentUserId,
  client,
  sessionId,
  userById,
}) => {
  const { token } = theme.useToken();

  const [prompt, setPrompt] = useState(() =>
    sessionId ? getPromptDraft(currentUserId, sessionId) : ''
  );
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  useEffect(() => {
    setPrompt(sessionId ? getPromptDraft(currentUserId, sessionId) : '');
  }, [currentUserId, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const timer = setTimeout(() => savePromptDraft(currentUserId, sessionId, prompt), 300);
    return () => clearTimeout(timer);
  }, [currentUserId, prompt, sessionId]);

  const handleSend = async () => {
    const draftText = prompt;
    const sentText = draftText.trim();
    if (!sentText || disabled || !sessionId) return;
    const result = await onSend(sentText);
    if (result === false) return;
    if (promptRef.current === draftText) setPrompt('');
    deletePromptDraft(currentUserId, sessionId, draftText);
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: token.colorBgContainer,
        borderTop: `1px solid ${token.colorBorder}`,
        padding: '12px 16px',
        zIndex: 1000,
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-end',
      }}
    >
      <div style={{ flex: 1 }}>
        <AutocompleteTextarea
          value={prompt}
          onChange={setPrompt}
          onKeyPress={handleKeyPress}
          placeholder={placeholder}
          client={client}
          sessionId={sessionId}
          userById={userById}
          autoSize={{ minRows: 1, maxRows: 4 }}
          enableKnowledgeMentions
          kbLinkTarget="absolute-route"
        />
      </div>
      <Button
        type="primary"
        icon={<SendOutlined />}
        onClick={() => void handleSend()}
        disabled={disabled || !prompt.trim()}
        size="large"
      />
    </div>
  );
};
