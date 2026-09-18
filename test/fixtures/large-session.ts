import type { Message, MessageID, SessionID, Task, TaskID } from '../../packages/core/src/types';
import { MessageRole, TaskStatus } from '../../packages/core/src/types';

// Fictional, deterministic data only. Shared by transport and browser profiling.
export function largeSessionFixture(taskCount = 500, messagesPerTask = 20) {
  const sessionId = '01990000-0000-7000-8000-000000000001' as SessionID;
  const tasks: Task[] = [];
  const messages: Message[] = [];
  for (let i = 0; i < taskCount; i++) {
    const taskId = `01990001-0000-7000-8000-${String(i).padStart(12, '0')}` as TaskID;
    const timestamp = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    tasks.push({
      task_id: taskId,
      session_id: sessionId,
      created_by: '01990000-0000-7000-8000-000000000002',
      full_prompt: `Fictional task ${i}: implement the observatory chart.\n${'Use synthetic star measurements. '.repeat(20)}`,
      status: TaskStatus.COMPLETED,
      created_at: timestamp,
      message_range: {
        start_index: i * messagesPerTask,
        end_index: (i + 1) * messagesPerTask - 1,
        start_timestamp: timestamp,
      },
      tool_use_count: 8,
      git_state: { ref_at_start: 'fixture', sha_at_start: '0'.repeat(40) },
    });
    for (let j = 0; j < messagesPerTask; j++) {
      const index = i * messagesPerTask + j;
      const toolId = `fixture-read-${i}-${Math.floor(j / 4)}`;
      const content: Message['content'] =
        j % 4 === 1
          ? [
              {
                type: 'tool_use',
                id: toolId,
                name: 'Read',
                input: { file_path: '/fictional/stars.ts' },
              },
            ]
          : j % 4 === 2
            ? [
                {
                  type: 'tool_result',
                  tool_use_id: toolId,
                  content: 'fictional star,42,17\n'.repeat(100),
                },
              ]
            : `## Observatory ${i}/${j}\n\nSynthetic measurements only.\n\n\`\`\`typescript\nconst stars = [${Array.from({ length: 20 }, (_, k) => k).join(', ')}];\n\`\`\`\n\n[Chart artifact](https://example.invalid/fictional-chart)\n`;
      messages.push({
        message_id: `01990002-0000-7000-8000-${String(index).padStart(12, '0')}` as MessageID,
        session_id: sessionId,
        task_id: taskId,
        index,
        timestamp,
        type: j % 4 === 2 ? 'user' : 'assistant',
        role: j % 4 === 2 ? MessageRole.USER : MessageRole.ASSISTANT,
        content_preview: `Fictional message ${index}`,
        content,
      });
    }
  }
  return { sessionId, tasks, messages };
}
