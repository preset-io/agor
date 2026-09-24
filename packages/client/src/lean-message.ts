import { LEAN_TRANSCRIPT_METADATA_FIELDS, type Message } from '@agor/core/client';

/** Browser counterpart of MessageRepository's SQL lean projection. No history is deleted. */
export function leanMessage(message: Message): Message {
  let content = message.content;
  const thinking = Array.isArray(content) && content.some((block) => block.type === 'thinking');
  if (Array.isArray(content)) {
    content = content.filter(
      (block) => !['tool_use', 'tool_result', 'thinking'].includes(block.type)
    );
  } else if (
    message.type === 'permission_request' &&
    content &&
    typeof content === 'object' &&
    'tool_input' in content &&
    content.status !== 'pending'
  ) {
    content = { ...content, tool_input: {} };
  }
  return {
    ...message,
    content,
    content_preview: '',
    tool_uses: undefined,
    has_deferred_reasoning: message.has_deferred_reasoning || thinking || undefined,
    metadata: Object.fromEntries(
      Object.entries(message.metadata ?? {}).filter(
        ([key]) =>
          LEAN_TRANSCRIPT_METADATA_FIELDS.some((field) => field === key) &&
          (key !== 'widget' || message.type === 'widget_request')
      )
    ),
  };
}
