import { ReloadOutlined, SmileOutlined } from '@ant-design/icons';
import { Button, Flex, Form, Input, Popover, Typography } from 'antd';
import type { EmojiClickData, PickerProps } from 'emoji-picker-react';
import { lazy, Suspense, useState } from 'react';
import { ErrorBoundary, isDynamicImportLoadError } from '../ErrorBoundary';

// Lazy-load the emoji-picker-react render (~60KB) so the library is fetched
// only when a picker is first opened, not at app mount. Types above are
// `import type` and erase at compile time, so they don't pull the library in.
// A failed native import cannot be retried in the same document, so the local
// boundary below contains the failure and offers a full-page reload instead.
const AgorEmojiPickerInner = lazy(() => import('./AgorEmojiPickerInner'));

/**
 * Sized placeholder matching the picker's footprint (350x400) so the popover
 * doesn't reflow when the lazy chunk resolves.
 */
const EmojiPickerFallback: React.FC = () => (
  <Flex align="center" justify="center" style={{ width: 350, height: 400 }}>
    <Typography.Text type="secondary">Loading…</Typography.Text>
  </Flex>
);

export const EmojiPickerErrorFallback: React.FC<{
  error: Error;
  onReload?: () => void;
}> = ({ error, onReload = () => window.location.reload() }) => {
  const isLoadError = isDynamicImportLoadError(error);

  return (
    <Flex vertical align="center" justify="center" gap="small" style={{ width: 350, height: 400 }}>
      <Typography.Text type="secondary">
        {isLoadError ? "Couldn't load the emoji picker." : 'The emoji picker is unavailable.'}
      </Typography.Text>
      {isLoadError ? (
        <Button size="small" icon={<ReloadOutlined />} aria-label="Reload page" onClick={onReload}>
          Reload page
        </Button>
      ) : null}
    </Flex>
  );
};

const EmojiPickerBoundary: React.FC<React.PropsWithChildren> = ({ children }) => (
  <ErrorBoundary fallbackRender={({ error }) => <EmojiPickerErrorFallback error={error} />}>
    {children}
  </ErrorBoundary>
);

/**
 * Shared <EmojiPicker /> wrapper that pins CSP-safe and visually-consistent
 * defaults. Always use this instead of importing EmojiPicker directly — the
 * library defaults to EmojiStyle.APPLE which lazy-loads PNGs from
 * cdn.jsdelivr.net, blocked by Agor's default img-src CSP.
 */
export const AgorEmojiPicker: React.FC<Pick<PickerProps, 'onEmojiClick'>> = ({ onEmojiClick }) => (
  <EmojiPickerBoundary>
    <Suspense fallback={<EmojiPickerFallback />}>
      <AgorEmojiPickerInner onEmojiClick={onEmojiClick} />
    </Suspense>
  </EmojiPickerBoundary>
);

interface EmojiPickerInputProps {
  value?: string;
  onChange?: (value: string) => void;
  defaultEmoji?: string;
  disabled?: boolean;
}

/**
 * Reusable emoji picker input — compact style with emoji preview + picker button.
 * Use directly with value/onChange, or use FormEmojiPickerInput for Ant Design forms.
 */
export const EmojiPickerInput: React.FC<EmojiPickerInputProps> = ({
  value,
  onChange,
  defaultEmoji = '📋',
  disabled = false,
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    onChange?.(emojiData.emoji);
    setPickerOpen(false);
  };

  // When disabled, keep the popover closed and never open it on click.
  const effectivePickerOpen = disabled ? false : pickerOpen;

  return (
    <div style={{ display: 'flex', gap: 0 }}>
      <Input
        prefix={<span style={{ fontSize: 14 }}>{value || defaultEmoji}</span>}
        readOnly
        disabled={disabled}
        style={{
          cursor: 'default',
          width: 40,
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
        }}
      />
      <Popover
        content={<AgorEmojiPicker onEmojiClick={handleEmojiClick} />}
        trigger={disabled ? [] : 'click'}
        open={effectivePickerOpen}
        onOpenChange={(next) => {
          if (disabled) return;
          setPickerOpen(next);
        }}
        placement="right"
      >
        <Button
          icon={<SmileOutlined />}
          disabled={disabled}
          style={{
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            borderLeft: 'none',
          }}
        />
      </Popover>
    </div>
  );
};

/**
 * Form.Item wrapper that integrates with Ant Design forms.
 * Registers the emoji field with the form so validateFields/getFieldsValue
 * include it in submitted values.
 */
export const FormEmojiPickerInput: React.FC<{
  form: ReturnType<typeof Form.useForm>[0];
  fieldName: string;
  defaultEmoji?: string;
}> = ({ fieldName, defaultEmoji }) => {
  return (
    <Form.Item name={fieldName} noStyle initialValue={defaultEmoji}>
      <EmojiPickerInput defaultEmoji={defaultEmoji} />
    </Form.Item>
  );
};
