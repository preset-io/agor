import EmojiPicker, { EmojiStyle, type PickerProps, Theme } from 'emoji-picker-react';

/**
 * The actual `emoji-picker-react` render. Split into its own module so the
 * library (~60KB) is only pulled in via the React.lazy import in
 * `EmojiPickerInput.tsx` — i.e. when a picker is first opened, not at app
 * mount. Pins the same CSP-safe / visually-consistent defaults as before.
 */
const AgorEmojiPickerInner: React.FC<Pick<PickerProps, 'onEmojiClick'>> = ({ onEmojiClick }) => (
  <EmojiPicker
    onEmojiClick={onEmojiClick}
    theme={Theme.DARK}
    emojiStyle={EmojiStyle.NATIVE}
    width={350}
    height={400}
  />
);

export default AgorEmojiPickerInner;
