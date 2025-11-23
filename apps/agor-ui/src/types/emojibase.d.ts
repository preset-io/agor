declare module 'emojibase-data/en/compact.json' {
  // biome-ignore lint/suspicious/noExplicitAny: External JSON module type
  const data: any[];
  export default data;
}

declare module 'emojibase-data/en/shortcodes/emojibase.json' {
  const data: Record<string, string | string[]>;
  export default data;
}
