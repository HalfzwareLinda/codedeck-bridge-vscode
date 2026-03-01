import { describe, it, expect } from 'vitest';
import { parseJsonlLine, extractSessionMeta } from '../jsonlParser';

describe('parseJsonlLine', () => {
  it('returns empty for empty input', () => {
    expect(parseJsonlLine('')).toEqual([]);
    expect(parseJsonlLine('  ')).toEqual([]);
  });

  it('returns empty for invalid JSON', () => {
    expect(parseJsonlLine('not json')).toEqual([]);
    expect(parseJsonlLine('{broken')).toEqual([]);
  });

  it('skips queue-operation lines', () => {
    const line = JSON.stringify({
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: '2026-02-09T18:59:57.199Z',
      sessionId: '00ad78e2-a612-49a4-8533-8421f5e9306a',
    });
    expect(parseJsonlLine(line)).toEqual([]);
  });

  it('skips file-history-snapshot lines', () => {
    const line = JSON.stringify({
      type: 'file-history-snapshot',
      messageId: 'abc123',
      snapshot: {},
    });
    expect(parseJsonlLine(line)).toEqual([]);
  });

  it('skips progress lines', () => {
    const line = JSON.stringify({
      type: 'progress',
      uuid: 'abc',
      timestamp: '2026-02-09T19:00:00Z',
      data: { hook: 'pre' },
    });
    expect(parseJsonlLine(line)).toEqual([]);
  });

  it('parses user text messages', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: 'session-1',
      cwd: '/workspace',
      timestamp: '2026-02-09T19:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    });

    const entries = parseJsonlLine(line);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('text');
    expect(entries[0].content).toBe('Hello world');
    expect(entries[0].metadata).toEqual({ role: 'user' });
  });

  it('parses user tool_result blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      parentUuid: 'p1',
      sessionId: 'session-1',
      cwd: '/workspace',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool1', content: 'File contents here' },
        ],
      },
    });

    const entries = parseJsonlLine(line);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('tool_result');
    expect(entries[0].content).toBe('File contents here');
    expect(entries[0].metadata).toEqual({ tool_use_id: 'tool1' });
  });

  it('truncates long tool results at 2000 chars', () => {
    const longContent = 'x'.repeat(3000);
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      parentUuid: 'p1',
      sessionId: 'session-1',
      cwd: '/workspace',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool1', content: longContent },
        ],
      },
    });

    const entries = parseJsonlLine(line);
    expect(entries[0].content).toHaveLength(2000 + '...[truncated]'.length);
    expect(entries[0].content).toContain('...[truncated]');
  });

  it('parses assistant text messages', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: 'session-1',
      cwd: '/workspace',
      timestamp: '2026-02-09T19:00:01Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'Here is my response' }],
      },
    });

    const entries = parseJsonlLine(line);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('text');
    expect(entries[0].content).toBe('Here is my response');
    expect(entries[0].metadata).toEqual({ role: 'assistant', model: 'claude-opus-4-6' });
  });

  it('parses assistant tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: 'session-1',
      cwd: '/workspace',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    });

    const entries = parseJsonlLine(line);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('tool_use');
    expect(entries[0].content).toBe('Bash: ls -la');
    expect(entries[0].metadata).toMatchObject({ tool_name: 'Bash' });
  });

  it('formats different tool types correctly', () => {
    const tools = [
      { name: 'Read', input: { file_path: '/src/main.ts' }, expected: 'Read: /src/main.ts' },
      { name: 'Write', input: { file_path: '/out.txt' }, expected: 'Write: /out.txt' },
      { name: 'Edit', input: { file_path: '/edit.ts' }, expected: 'Edit: /edit.ts' },
      { name: 'Glob', input: { pattern: '**/*.ts' }, expected: 'Glob: **/*.ts' },
      { name: 'Grep', input: { pattern: 'function\\s+\\w+' }, expected: 'Grep: function\\s+\\w+' },
      { name: 'Task', input: { description: 'search', subagent_type: 'Explore' }, expected: 'Task: search (Explore)' },
      { name: 'WebSearch', input: { query: 'nostr protocol' }, expected: 'WebSearch: nostr protocol' },
      { name: 'WebFetch', input: { url: 'https://example.com' }, expected: 'WebFetch: https://example.com' },
    ];

    for (const { name, input, expected } of tools) {
      const line = JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        cwd: '/w',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'id', name, input }],
        },
      });

      const entries = parseJsonlLine(line);
      expect(entries[0].content).toBe(expected);
    }
  });

  it('parses token usage from assistant messages', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: 'session-1',
      cwd: '/workspace',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 1250, output_tokens: 340 },
      },
    });

    const entries = parseJsonlLine(line);
    expect(entries).toHaveLength(2); // text + usage
    expect(entries[1].entryType).toBe('system');
    expect(entries[1].content).toBe('Tokens: 1250 in / 340 out');
    expect(entries[1].metadata).toEqual({ usage: { input_tokens: 1250, output_tokens: 340 } });
  });

  it('parses system messages', () => {
    const line = JSON.stringify({
      type: 'system',
      uuid: 's1',
      subtype: 'init',
      content: 'Session initialized',
      timestamp: '2026-02-09T19:00:00Z',
    });

    const entries = parseJsonlLine(line);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('system');
    expect(entries[0].content).toBe('Session initialized');
    expect(entries[0].metadata).toEqual({ subtype: 'init' });
  });

  it('skips system messages with no content', () => {
    const line = JSON.stringify({
      type: 'system',
      uuid: 's1',
    });
    expect(parseJsonlLine(line)).toEqual([]);
  });

  it('parses assistant messages with mixed content blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: 's1',
      cwd: '/w',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check the file.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/src/app.ts' } },
        ],
      },
    });

    const entries = parseJsonlLine(line);
    expect(entries).toHaveLength(2);
    expect(entries[0].entryType).toBe('text');
    expect(entries[1].entryType).toBe('tool_use');
    expect(entries[1].content).toBe('Read: /src/app.ts');
  });

  it('handles real JSONL from Claude Code', () => {
    // Real user message from a Claude Code session
    const userLine = '{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/home/jeroen/VScode workspace for building nostr apps","sessionId":"00ad78e2-a612-49a4-8533-8421f5e9306a","version":"2.1.37","gitBranch":"HEAD","type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello Claude"}]},"uuid":"a93e967a-c990-4ca9-9dc7-3f2e03e93407","timestamp":"2026-02-09T18:59:57.210Z","permissionMode":"bypassPermissions"}';

    const entries = parseJsonlLine(userLine);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('text');
    expect(entries[0].content).toBe('Hello Claude');
    expect(entries[0].timestamp).toBe('2026-02-09T18:59:57.210Z');
  });
});

describe('extractSessionMeta', () => {
  it('returns null for empty lines', () => {
    expect(extractSessionMeta([])).toBeNull();
  });

  it('returns null for lines without sessionId/cwd', () => {
    expect(extractSessionMeta(['{"type":"progress","uuid":"x"}'])).toBeNull();
  });

  it('extracts session metadata from user line', () => {
    const lines = [
      '{"type":"queue-operation","operation":"dequeue","sessionId":"sess-123"}',
      '{"type":"user","sessionId":"sess-123","cwd":"/workspace","slug":"my-session","uuid":"u1","parentUuid":null,"message":{"role":"user","content":[]}}',
    ];

    const meta = extractSessionMeta(lines);
    expect(meta).toEqual({
      sessionId: 'sess-123',
      slug: 'my-session',
      cwd: '/workspace',
    });
  });

  it('uses session ID prefix as slug fallback', () => {
    const lines = [
      '{"type":"user","sessionId":"abcdef12-3456-7890","cwd":"/workspace","uuid":"u1","parentUuid":null,"message":{"role":"user","content":[]}}',
    ];

    const meta = extractSessionMeta(lines);
    expect(meta?.slug).toBe('abcdef12');
  });

  it('skips invalid JSON lines gracefully', () => {
    const lines = [
      'not valid json',
      '{"type":"user","sessionId":"sess-1","cwd":"/w","uuid":"u1","parentUuid":null,"message":{"role":"user","content":[]}}',
    ];

    const meta = extractSessionMeta(lines);
    expect(meta?.sessionId).toBe('sess-1');
  });

  it('returns meta with fallback cwd when only sessionId is present', () => {
    const lines = [
      '{"type":"queue-operation","operation":"dequeue","sessionId":"sess-abc","timestamp":"2026-02-09T19:00:00Z"}',
      '{"type":"file-history-snapshot","messageId":"m1","snapshot":{}}',
    ];

    const meta = extractSessionMeta(lines, '/fallback/workspace');
    expect(meta).toEqual({
      sessionId: 'sess-abc',
      slug: 'sess-abc',
      cwd: '/fallback/workspace',
    });
  });

  it('returns null without fallback cwd when only sessionId is present', () => {
    const lines = [
      '{"type":"queue-operation","operation":"dequeue","sessionId":"sess-abc"}',
    ];

    const meta = extractSessionMeta(lines);
    expect(meta).toBeNull();
  });

  it('prefers real cwd over fallback when both exist in lines', () => {
    const lines = [
      '{"type":"queue-operation","operation":"dequeue","sessionId":"sess-abc"}',
      '{"type":"user","sessionId":"sess-abc","cwd":"/real/path","uuid":"u1","parentUuid":null,"message":{"role":"user","content":[]}}',
    ];

    const meta = extractSessionMeta(lines, '/fallback/workspace');
    expect(meta).toEqual({
      sessionId: 'sess-abc',
      slug: 'sess-abc',
      cwd: '/real/path',
    });
  });
});
