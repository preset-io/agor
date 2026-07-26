function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  if (!block || typeof block !== 'object') return false;
  const record = block as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string';
}

export function toolResultToDisplayText(content: string | unknown[]): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const textBlocks = content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join('\n\n');
    if (textBlocks.trim().length > 0) {
      return textBlocks;
    }

    // Preserve visibility for non-text payloads (e.g., MCP structured blocks).
    return JSON.stringify(content, null, 2);
  }

  return '';
}
