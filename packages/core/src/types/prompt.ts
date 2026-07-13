/**
 * Fold stored attachment paths into an agent prompt.
 *
 * Slash commands must remain the first line so command dispatch keeps working;
 * regular prompts put attachments first so the agent sees the file context
 * before the user's instructions.
 */
export function buildPromptWithAttachments(text: string, attachmentPaths: string[]): string {
  const trimmedText = text.trim();
  if (attachmentPaths.length === 0) return trimmedText;

  const attachmentBlock = [
    'Attached files:',
    ...attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
  ].join('\n');
  if (trimmedText.startsWith('/')) {
    return `${trimmedText}\n\n${attachmentBlock}`;
  }
  return trimmedText ? `${attachmentBlock}\n\n${trimmedText}` : attachmentBlock;
}
