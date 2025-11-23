import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildConversationTree,
  type ConversationNode,
  filterConversationMessages,
  getTranscriptPath,
  loadSessionTranscript,
  parseTranscript,
  type TranscriptMessage,
} from './transcript-parser';

// ============================================================================
// Test Helpers - Inline transcript message builders
// ============================================================================

function createUserMessage(
  uuid: string,
  parentUuid: string | null = null,
  content: string = 'Test message'
): TranscriptMessage {
  return {
    type: 'user',
    uuid,
    sessionId: 'test-session',
    timestamp: '2025-01-15T10:00:00Z',
    parentUuid,
    cwd: '/test/dir',
    gitBranch: 'main',
    version: '1.0.0',
    message: {
      role: 'user',
      content,
    },
    isMeta: false,
    isSidechain: false,
  };
}

function createAssistantMessage(
  uuid: string,
  parentUuid: string | null = null,
  content: string = 'Test response'
): TranscriptMessage {
  return {
    type: 'assistant',
    uuid,
    sessionId: 'test-session',
    timestamp: '2025-01-15T10:01:00Z',
    parentUuid,
    message: {
      role: 'assistant',
      content,
    },
    isMeta: false,
    isSidechain: false,
  };
}

function createMetaMessage(uuid: string): TranscriptMessage {
  return {
    type: 'user',
    uuid,
    sessionId: 'test-session',
    timestamp: '2025-01-15T10:02:00Z',
    parentUuid: null,
    message: {
      role: 'user',
      content: 'Meta wrapper',
    },
    isMeta: true,
    isSidechain: false,
  };
}

function createFileHistorySnapshot(messageId: string): TranscriptMessage {
  return {
    type: 'file-history-snapshot',
    messageId,
    sessionId: 'test-session',
    timestamp: '2025-01-15T10:03:00Z',
    snapshot: { files: {} },
    isSnapshotUpdate: false,
  };
}

function createToolResultMessage(
  uuid: string,
  parentUuid: string | null = null
): TranscriptMessage {
  return {
    type: 'assistant',
    uuid,
    sessionId: 'test-session',
    timestamp: '2025-01-15T10:04:00Z',
    parentUuid,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-123',
          content: 'Result',
        },
      ],
    },
    isMeta: false,
    isSidechain: false,
  };
}

function createCommandMessage(uuid: string, commandType: string): TranscriptMessage {
  return {
    type: 'user',
    uuid,
    sessionId: 'test-session',
    timestamp: '2025-01-15T10:05:00Z',
    parentUuid: null,
    message: {
      role: 'user',
      content: `<${commandType}>command content</${commandType}>`,
    },
    isMeta: false,
    isSidechain: false,
  };
}

function createTempTranscriptFile(messages: TranscriptMessage[]): string {
  const tmpFile = path.join(os.tmpdir(), `test-transcript-${Date.now()}.jsonl`);
  const lines = messages.map((msg) => JSON.stringify(msg)).join('\n');
  fs.writeFileSync(tmpFile, lines, 'utf-8');
  return tmpFile;
}

// ============================================================================
// Tests: getTranscriptPath
// ============================================================================

describe('getTranscriptPath', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should generate transcript path with HOME directory', () => {
    process.env.HOME = '/Users/testuser';
    const sessionId = 'test-session-123';
    const projectDir = '/Users/testuser/code/myproject';

    const transcriptPath = getTranscriptPath(sessionId, projectDir);

    expect(transcriptPath).toBe(
      '/Users/testuser/.claude/projects/-Users-testuser-code-myproject/test-session-123.jsonl'
    );
  });

  it('should use USERPROFILE on Windows when HOME is not set', () => {
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\testuser';
    const sessionId = 'test-session-456';
    const projectDir = 'C:\\Users\\testuser\\code\\myproject';

    const transcriptPath = getTranscriptPath(sessionId, projectDir);

    expect(transcriptPath).toContain('.claude');
    expect(transcriptPath).toContain('test-session-456.jsonl');
  });

  it('should throw error when neither HOME nor USERPROFILE is set', () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    expect(() => getTranscriptPath('test-session', '/some/path')).toThrow(
      'Could not determine home directory'
    );
  });

  it('should use current working directory when projectDir is not provided', () => {
    process.env.HOME = '/Users/testuser';
    const sessionId = 'test-session-789';
    const cwd = process.cwd();

    const transcriptPath = getTranscriptPath(sessionId);
    const expectedSlug = cwd.replace(/\//g, '-').replace(/\\/g, '-');

    expect(transcriptPath).toContain(expectedSlug);
    expect(transcriptPath).toContain('test-session-789.jsonl');
  });

  it('should escape forward slashes in project path', () => {
    process.env.HOME = '/Users/testuser';
    const sessionId = 'session-1';
    const projectDir = '/Users/testuser/code/agor/packages/core';

    const transcriptPath = getTranscriptPath(sessionId, projectDir);

    expect(transcriptPath).toContain('-Users-testuser-code-agor-packages-core');
    expect(transcriptPath).not.toContain('//');
  });

  it('should escape backslashes in project path (Windows)', () => {
    process.env.HOME = '/Users/testuser';
    const sessionId = 'session-2';
    const projectDir = 'C:\\Users\\testuser\\code\\project';

    const transcriptPath = getTranscriptPath(sessionId, projectDir);

    expect(transcriptPath).toContain('C:-Users-testuser-code-project');
    expect(transcriptPath).not.toContain('\\');
  });

  it('should handle mixed slashes in project path', () => {
    process.env.HOME = '/Users/testuser';
    const sessionId = 'session-3';
    const projectDir = '/Users/testuser\\code/project\\dir';

    const transcriptPath = getTranscriptPath(sessionId, projectDir);

    expect(transcriptPath).toContain('-Users-testuser-code-project-dir');
  });

  it('should handle project paths with special characters', () => {
    process.env.HOME = '/Users/testuser';
    const sessionId = 'session-4';
    const projectDir = '/Users/testuser/code/my-project_v2.0';

    const transcriptPath = getTranscriptPath(sessionId, projectDir);

    expect(transcriptPath).toContain('-Users-testuser-code-my-project_v2.0');
    expect(transcriptPath).toContain('session-4.jsonl');
  });
});

// ============================================================================
// Tests: parseTranscript
// ============================================================================

describe('parseTranscript', () => {
  let tmpFile: string;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it('should parse valid JSONL transcript file', async () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1', null, 'Hello'),
      createAssistantMessage('msg-2', 'msg-1', 'Hi there'),
    ];
    tmpFile = createTempTranscriptFile(messages);

    const result = await parseTranscript(tmpFile);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('user');
    expect(result[0].message?.content).toBe('Hello');
    expect(result[1].type).toBe('assistant');
    expect(result[1].message?.content).toBe('Hi there');
  });

  it('should throw error when file does not exist', async () => {
    const nonExistentPath = '/tmp/nonexistent-transcript-file.jsonl';

    await expect(parseTranscript(nonExistentPath)).rejects.toThrow(
      `Transcript file not found: ${nonExistentPath}`
    );
  });

  it('should skip empty lines in transcript', async () => {
    const messages: TranscriptMessage[] = [createUserMessage('msg-1')];
    tmpFile = createTempTranscriptFile(messages);

    // Add empty lines
    const content = fs.readFileSync(tmpFile, 'utf-8');
    fs.writeFileSync(tmpFile, `${content}\n\n\n`, 'utf-8');

    const result = await parseTranscript(tmpFile);

    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe('msg-1');
  });

  it('should skip whitespace-only lines', async () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createAssistantMessage('msg-2', 'msg-1'),
    ];
    tmpFile = createTempTranscriptFile(messages);

    // Add whitespace lines
    const content = fs.readFileSync(tmpFile, 'utf-8');
    fs.writeFileSync(tmpFile, `${content}\n   \n\t\t\n  `, 'utf-8');

    const result = await parseTranscript(tmpFile);

    expect(result).toHaveLength(2);
  });

  it('should throw error on malformed JSON line', async () => {
    tmpFile = path.join(os.tmpdir(), `test-transcript-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpFile, 'not valid json\n', 'utf-8');

    await expect(parseTranscript(tmpFile)).rejects.toThrow();
  });

  it('should parse complex message with array content', async () => {
    const message: TranscriptMessage = {
      type: 'assistant',
      uuid: 'msg-complex',
      sessionId: 'test-session',
      timestamp: '2025-01-15T10:00:00Z',
      parentUuid: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is the result:' },
          { type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'ls' } },
        ],
      },
    };
    tmpFile = createTempTranscriptFile([message]);

    const result = await parseTranscript(tmpFile);

    expect(result).toHaveLength(1);
    expect(Array.isArray(result[0].message?.content)).toBe(true);
    expect((result[0].message?.content as Array<unknown>)[0]).toHaveProperty('type', 'text');
  });

  it('should parse file-history-snapshot messages', async () => {
    const snapshot = createFileHistorySnapshot('msg-1');
    tmpFile = createTempTranscriptFile([snapshot]);

    const result = await parseTranscript(tmpFile);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('file-history-snapshot');
    expect(result[0].messageId).toBe('msg-1');
    expect(result[0].snapshot).toBeDefined();
  });

  it('should handle large transcript files', async () => {
    const messages: TranscriptMessage[] = [];
    for (let i = 0; i < 1000; i++) {
      messages.push(createUserMessage(`msg-${i}`, i > 0 ? `msg-${i - 1}` : null, `Message ${i}`));
    }
    tmpFile = createTempTranscriptFile(messages);

    const result = await parseTranscript(tmpFile);

    expect(result).toHaveLength(1000);
    expect(result[0].uuid).toBe('msg-0');
    expect(result[999].uuid).toBe('msg-999');
  });

  it('should preserve all message fields', async () => {
    const message: TranscriptMessage = {
      type: 'user',
      uuid: 'msg-full',
      sessionId: 'session-123',
      timestamp: '2025-01-15T12:34:56Z',
      parentUuid: 'parent-uuid',
      cwd: '/home/user/project',
      gitBranch: 'feature-branch',
      version: '2.0.0',
      message: {
        role: 'user',
        content: 'Full message',
      },
      isMeta: false,
      isSidechain: true,
    };
    tmpFile = createTempTranscriptFile([message]);

    const result = await parseTranscript(tmpFile);

    expect(result[0]).toEqual(message);
  });
});

// ============================================================================
// Tests: loadSessionTranscript
// ============================================================================

describe('loadSessionTranscript', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    process.env.HOME = os.tmpdir();
    tmpDir = path.join(os.tmpdir(), '.claude', 'projects');
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should load transcript for valid session ID', async () => {
    const sessionId = 'session-load-test';
    const projectDir = '/test/project';
    const projectSlug = '-test-project';
    const transcriptDir = path.join(tmpDir, projectSlug);

    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createAssistantMessage('msg-2', 'msg-1'),
    ];
    fs.writeFileSync(transcriptPath, messages.map((m) => JSON.stringify(m)).join('\n'), 'utf-8');

    const result = await loadSessionTranscript(sessionId, projectDir);

    expect(result).toHaveLength(2);
    expect(result[0].uuid).toBe('msg-1');
    expect(result[1].uuid).toBe('msg-2');
  });

  it('should throw error when transcript file does not exist', async () => {
    const sessionId = 'nonexistent-session';
    const projectDir = '/test/project';

    await expect(loadSessionTranscript(sessionId, projectDir)).rejects.toThrow(
      'Transcript file not found'
    );
  });

  it('should use current working directory when projectDir not provided', async () => {
    const sessionId = 'session-cwd-test';
    const cwd = process.cwd();
    const projectSlug = cwd.replace(/\//g, '-').replace(/\\/g, '-');
    const transcriptDir = path.join(tmpDir, projectSlug);

    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    const messages: TranscriptMessage[] = [createUserMessage('msg-1')];
    fs.writeFileSync(transcriptPath, messages.map((m) => JSON.stringify(m)).join('\n'), 'utf-8');

    const result = await loadSessionTranscript(sessionId);

    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe('msg-1');
  });
});

// ============================================================================
// Tests: filterConversationMessages
// ============================================================================

describe('filterConversationMessages', () => {
  it('should include user and assistant messages', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createAssistantMessage('msg-2', 'msg-1'),
    ];

    const result = filterConversationMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('user');
    expect(result[1].type).toBe('assistant');
  });

  it('should exclude file-history-snapshot messages', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createFileHistorySnapshot('msg-1'),
      createAssistantMessage('msg-2', 'msg-1'),
    ];

    const result = filterConversationMessages(messages);

    expect(result).toHaveLength(2);
    expect(result.every((m) => m.type !== 'file-history-snapshot')).toBe(true);
  });

  it('should exclude meta messages', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createMetaMessage('meta-1'),
      createAssistantMessage('msg-2', 'msg-1'),
    ];

    const result = filterConversationMessages(messages);

    expect(result).toHaveLength(2);
    expect(result.every((m) => !m.isMeta)).toBe(true);
  });

  it('should exclude tool_result messages', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createToolResultMessage('tool-1', 'msg-1'),
      createAssistantMessage('msg-2', 'msg-1'),
    ];

    const result = filterConversationMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('user');
    expect(result[1].type).toBe('assistant');
  });

  it('should exclude command-name messages', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createCommandMessage('cmd-1', 'command-name'),
      createAssistantMessage('msg-2', 'msg-1'),
    ];

    const result = filterConversationMessages(messages);

    expect(result).toHaveLength(2);
    expect(
      result.every((m) => {
        const content = m.message?.content;
        return typeof content !== 'string' || !content.includes('<command-name>');
      })
    ).toBe(true);
  });

  it('should exclude local-command-stdout messages', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createCommandMessage('cmd-1', 'local-command-stdout'),
      createAssistantMessage('msg-2', 'msg-1'),
    ];

    const result = filterConversationMessages(messages);

    expect(result).toHaveLength(2);
  });

  it('should exclude system-reminder messages', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createCommandMessage('cmd-1', 'system-reminder'),
      createAssistantMessage('msg-2', 'msg-1'),
    ];

    const result = filterConversationMessages(messages);

    expect(result).toHaveLength(2);
  });

  it('should handle mixed content with command markers in middle', () => {
    const message: TranscriptMessage = {
      type: 'user',
      uuid: 'msg-mixed',
      sessionId: 'test',
      timestamp: '2025-01-15T10:00:00Z',
      parentUuid: null,
      message: {
        role: 'user',
        content: 'Some text before\n<command-name>test</command-name>\nSome text after',
      },
    };

    const result = filterConversationMessages([message]);

    expect(result).toHaveLength(1);
  });

  it('should handle empty message list', () => {
    const result = filterConversationMessages([]);

    expect(result).toHaveLength(0);
  });

  it('should filter multiple message types at once', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createFileHistorySnapshot('snap-1'),
      createMetaMessage('meta-1'),
      createToolResultMessage('tool-1'),
      createCommandMessage('cmd-1', 'command-name'),
      createAssistantMessage('msg-2', 'msg-1'),
      createUserMessage('msg-3', 'msg-2'),
    ];

    const result = filterConversationMessages(messages);

    expect(result).toHaveLength(3);
    expect(result.map((m) => m.uuid)).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('should preserve message order', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1'),
      createAssistantMessage('msg-2', 'msg-1'),
      createUserMessage('msg-3', 'msg-2'),
      createAssistantMessage('msg-4', 'msg-3'),
    ];

    const result = filterConversationMessages(messages);

    expect(result.map((m) => m.uuid)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });
});

// ============================================================================
// Tests: buildConversationTree
// ============================================================================

describe('buildConversationTree', () => {
  it('should build simple linear conversation tree', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1', null),
      createAssistantMessage('msg-2', 'msg-1'),
      createUserMessage('msg-3', 'msg-2'),
    ];

    const roots = buildConversationTree(messages);

    expect(roots).toHaveLength(1);
    expect(roots[0].message.uuid).toBe('msg-1');
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0].message.uuid).toBe('msg-2');
    expect(roots[0].children[0].children).toHaveLength(1);
    expect(roots[0].children[0].children[0].message.uuid).toBe('msg-3');
  });

  it('should handle multiple root messages', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('root-1', null),
      createUserMessage('root-2', null),
      createAssistantMessage('msg-1', 'root-1'),
      createAssistantMessage('msg-2', 'root-2'),
    ];

    const roots = buildConversationTree(messages);

    expect(roots).toHaveLength(2);
    expect(roots[0].message.uuid).toBe('root-1');
    expect(roots[1].message.uuid).toBe('root-2');
    expect(roots[0].children[0].message.uuid).toBe('msg-1');
    expect(roots[1].children[0].message.uuid).toBe('msg-2');
  });

  it('should handle branching conversations', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('root', null),
      createAssistantMessage('branch-1', 'root'),
      createAssistantMessage('branch-2', 'root'),
      createUserMessage('leaf-1', 'branch-1'),
      createUserMessage('leaf-2', 'branch-2'),
    ];

    const roots = buildConversationTree(messages);

    expect(roots).toHaveLength(1);
    expect(roots[0].children).toHaveLength(2);
    expect(roots[0].children[0].message.uuid).toBe('branch-1');
    expect(roots[0].children[1].message.uuid).toBe('branch-2');
    expect(roots[0].children[0].children[0].message.uuid).toBe('leaf-1');
    expect(roots[0].children[1].children[0].message.uuid).toBe('leaf-2');
  });

  it('should skip messages without uuid', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1', null),
      { ...createAssistantMessage('msg-2', 'msg-1'), uuid: undefined },
      createUserMessage('msg-3', 'msg-1'),
    ];

    const roots = buildConversationTree(messages);

    expect(roots).toHaveLength(1);
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0].message.uuid).toBe('msg-3');
  });

  it('should treat orphaned messages as roots when parent not found', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1', 'nonexistent-parent'),
      createAssistantMessage('msg-2', 'another-missing-parent'),
    ];

    const roots = buildConversationTree(messages);

    expect(roots).toHaveLength(2);
    expect(roots[0].message.uuid).toBe('msg-1');
    expect(roots[1].message.uuid).toBe('msg-2');
  });

  it('should handle empty message list', () => {
    const roots = buildConversationTree([]);

    expect(roots).toHaveLength(0);
  });

  it('should build deep conversation tree', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('msg-1', null),
      createAssistantMessage('msg-2', 'msg-1'),
      createUserMessage('msg-3', 'msg-2'),
      createAssistantMessage('msg-4', 'msg-3'),
      createUserMessage('msg-5', 'msg-4'),
    ];

    const roots = buildConversationTree(messages);

    let current: ConversationNode = roots[0];
    expect(current.message.uuid).toBe('msg-1');

    current = current.children[0];
    expect(current.message.uuid).toBe('msg-2');

    current = current.children[0];
    expect(current.message.uuid).toBe('msg-3');

    current = current.children[0];
    expect(current.message.uuid).toBe('msg-4');

    current = current.children[0];
    expect(current.message.uuid).toBe('msg-5');
    expect(current.children).toHaveLength(0);
  });

  it('should handle complex multi-branch tree', () => {
    const messages: TranscriptMessage[] = [
      createUserMessage('root', null),
      createAssistantMessage('a1', 'root'),
      createAssistantMessage('a2', 'root'),
      createUserMessage('b1', 'a1'),
      createUserMessage('b2', 'a1'),
      createUserMessage('b3', 'a2'),
      createAssistantMessage('c1', 'b1'),
      createAssistantMessage('c2', 'b2'),
    ];

    const roots = buildConversationTree(messages);

    expect(roots).toHaveLength(1);
    const root = roots[0];

    // Root has 2 children (a1, a2)
    expect(root.children).toHaveLength(2);

    // a1 has 2 children (b1, b2)
    expect(root.children[0].children).toHaveLength(2);

    // a2 has 1 child (b3)
    expect(root.children[1].children).toHaveLength(1);

    // b1 has 1 child (c1)
    expect(root.children[0].children[0].children).toHaveLength(1);

    // b2 has 1 child (c2)
    expect(root.children[0].children[1].children).toHaveLength(1);

    // b3 has no children
    expect(root.children[1].children[0].children).toHaveLength(0);
  });

  it('should preserve message references in nodes', () => {
    const originalMessage = createUserMessage('msg-1', null);
    const messages: TranscriptMessage[] = [originalMessage];

    const roots = buildConversationTree(messages);

    expect(roots[0].message).toBe(originalMessage);
  });
});
