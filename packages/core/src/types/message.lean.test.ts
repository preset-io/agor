import { expect, it } from 'vitest';
import {
  leanMessage,
  type Message,
  type PermissionRequestContent,
  PermissionStatus,
} from './message';

it('projects tools/reasoning and raw metadata without mutating text, attachments or history identity', () => {
  const source = {
    message_id: 'message',
    task_id: 'task',
    session_id: 'session',
    type: 'assistant',
    parent_tool_use_id: 'parent',
    content_preview: 'large output',
    content: [
      { type: 'text', text: 'Answer' },
      { type: 'image', source: { type: 'url', url: 'attachment.png' } },
      { type: 'tool_result', content: 'large' },
      { type: 'thinking', thinking: 'reasoning' },
    ],
    tool_uses: [{ input: { large: true } }],
    metadata: { model: 'model', raw: 'large', widget: { large: true } },
  } as unknown as Message;
  const lean = leanMessage(source);
  expect(lean).toMatchObject({
    message_id: 'message',
    task_id: 'task',
    parent_tool_use_id: 'parent',
    has_deferred_reasoning: true,
    content_preview: '',
    metadata: { model: 'model' },
  });
  expect(lean.content).toEqual((source.content as unknown[]).slice(0, 2));
  expect(lean.tool_uses).toBeUndefined();
  expect(lean.metadata).toEqual({ model: 'model' });
  expect(source.content).toHaveLength(4);
  expect(source.tool_uses).toHaveLength(1);
});

it('keeps pending permission arguments, dropping them only after the decision', () => {
  const content: PermissionRequestContent = {
    request_id: 'request',
    tool_name: 'Bash',
    status: PermissionStatus.PENDING,
    tool_input: { command: 'fixture' },
  };
  const source = { type: 'permission_request', content } as Message;
  expect(leanMessage(source).content).toEqual(content);
  expect(
    leanMessage({ ...source, content: { ...content, status: PermissionStatus.APPROVED } }).content
  ).toEqual({ ...content, status: PermissionStatus.APPROVED, tool_input: {} });
});
