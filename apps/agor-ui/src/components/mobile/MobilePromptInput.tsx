import type { AgorClient } from '@agor/core/api';
import type { SessionID, User } from '@agor/core/types';
import { SendOutlined } from '@ant-design/icons';
import { Button, theme } from 'antd';
import { AutocompleteTextarea } from '../AutocompleteTextarea';

interface MobilePromptInputProps {
  onSend: (prompt: string) => void;
  disabled?: boolean;
  placeholder?: string;
  promptDraft?: string; // Draft prompt text for this session
  onUpdateDraft?: (draft: string) => void; // Update draft callback
  client: AgorClient | null;
  sessionId: SessionID | null;
  userById: Map<string, User>;
}

export const MobilePromptInput: React.FC<MobilePromptInputProps> = ({
  onSend,
  disabled = false,
  placeholder = 'Send a prompt...',
  promptDraft = '',
  onUpdateDraft,
  client,
  sessionId,
  userById,
}) => {
  const { token } = theme.useToken();

  // Use prop-driven draft state instead of local state
  const prompt = promptDraft;
  const setPrompt = (value: string) => {
    onUpdateDraft?.(value);
  };

  const handleSend = () => {
    if (prompt.trim() && !disabled) {
      onSend(prompt.trim());
      // Draft clearing is now handled by parent (App.tsx)
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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
        />
      </div>
      <Button
        type="primary"
        icon={<SendOutlined />}
        onClick={handleSend}
        disabled={disabled || !prompt.trim()}
        size="large"
      />
    </div>
  );
};
