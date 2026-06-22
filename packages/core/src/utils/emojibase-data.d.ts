declare module 'emojibase-data/en/compact.json' {
  interface EmojibaseCompactEmoji {
    hexcode: string;
    unicode?: string;
    tags?: string[];
  }

  const data: EmojibaseCompactEmoji[];
  export default data;
}

declare module 'emojibase-data/en/shortcodes/emojibase.json' {
  const data: Record<string, string | string[]>;
  export default data;
}
