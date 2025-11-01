import { SendOutlined } from '@ant-design/icons';
import { Button, Input } from 'antd';
import { useState } from 'react';

const { TextArea } = Input;

interface MobilePromptInputProps {
  onSend: (prompt: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export const MobilePromptInput: React.FC<MobilePromptInputProps> = ({
  onSend,
  disabled = false,
  placeholder = 'Send a prompt...',
}) => {
  const [prompt, setPrompt] = useState('');

  const handleSend = () => {
    if (prompt.trim() && !disabled) {
      onSend(prompt.trim());
      setPrompt('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    // Send on Enter (without shift)
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
        background: '#141414',
        borderTop: '1px solid #303030',
        padding: '12px 16px',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-end',
        zIndex: 1000,
      }}
    >
      <TextArea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        onKeyDown={handleKeyPress}
        placeholder={placeholder}
        disabled={disabled}
        autoSize={{ minRows: 1, maxRows: 4 }}
        style={{
          flex: 1,
          resize: 'none',
        }}
      />
      <Button
        type="primary"
        icon={<SendOutlined />}
        onClick={handleSend}
        disabled={!prompt.trim() || disabled}
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      />
    </div>
  );
};
