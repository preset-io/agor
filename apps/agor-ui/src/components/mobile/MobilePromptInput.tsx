import { SendOutlined } from '@ant-design/icons';
import { Input, theme } from 'antd';

interface MobilePromptInputProps {
  onSend: (prompt: string) => void;
  disabled?: boolean;
  placeholder?: string;
  promptDraft?: string; // Draft prompt text for this session
  onUpdateDraft?: (draft: string) => void; // Update draft callback
}

export const MobilePromptInput: React.FC<MobilePromptInputProps> = ({
  onSend,
  disabled = false,
  placeholder = 'Send a prompt...',
  promptDraft = '',
  onUpdateDraft,
}) => {
  const { token } = theme.useToken();

  // Use prop-driven draft state instead of local state
  const prompt = promptDraft;
  const setPrompt = (value: string) => {
    onUpdateDraft?.(value);
  };

  const handleSend = (value: string) => {
    if (value.trim() && !disabled) {
      onSend(value.trim());
      // Draft clearing is now handled by parent (App.tsx)
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
      }}
    >
      <Input.Search
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        enterButton={<SendOutlined />}
        onSearch={handleSend}
        size="large"
      />
    </div>
  );
};
