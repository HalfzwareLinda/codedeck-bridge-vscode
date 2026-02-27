/**
 * Parse Claude Code JSONL session files into Codedeck OutputEntry messages.
 *
 * Claude Code writes session data as newline-delimited JSON to:
 *   ~/.claude/projects/<url-encoded-path>/<session-uuid>.jsonl
 *
 * Each line has a "type" field: user, assistant, system, progress,
 * file-history-snapshot, queue-operation.
 *
 * We translate these into OutputEntry objects that Codedeck can render.
 */

import type { ClaudeJsonlLine, ClaudeContentBlock, OutputEntry } from './types';

/**
 * Parse a single JSONL line into zero or more OutputEntry objects.
 * Returns empty array for lines we don't relay (snapshots, queue ops, progress).
 */
export function parseJsonlLine(line: string): OutputEntry[] {
  const trimmed = line.trim();
  if (!trimmed) { return []; }

  let parsed: ClaudeJsonlLine;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  switch (parsed.type) {
    case 'user':
      return parseUserLine(parsed);
    case 'assistant':
      return parseAssistantLine(parsed);
    case 'system':
      return parseSystemLine(parsed);
    case 'progress':
      // Progress events are noisy (hook callbacks etc), skip them
      return [];
    case 'file-history-snapshot':
    case 'queue-operation':
      // Internal bookkeeping, skip
      return [];
    default:
      return [];
  }
}

function parseUserLine(line: { type: 'user'; message: { content: ClaudeContentBlock[] }; timestamp?: string }): OutputEntry[] {
  const entries: OutputEntry[] = [];
  const ts = line.timestamp || new Date().toISOString();

  for (const block of line.message.content) {
    if (block.type === 'text') {
      entries.push({
        entryType: 'text',
        content: block.text,
        timestamp: ts,
        metadata: { role: 'user' },
      });
    } else if (block.type === 'tool_result') {
      const text = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map(c => c.text)
            .join('\n')
          : '';
      if (text) {
        entries.push({
          entryType: 'tool_result',
          content: text.length > 2000 ? text.slice(0, 2000) + '...[truncated]' : text,
          timestamp: ts,
          metadata: { tool_use_id: block.tool_use_id },
        });
      }
    }
  }

  return entries;
}

function parseAssistantLine(line: {
  type: 'assistant';
  message: { content: ClaudeContentBlock[]; model?: string; usage?: { input_tokens: number; output_tokens: number } };
  timestamp?: string;
}): OutputEntry[] {
  const entries: OutputEntry[] = [];
  const ts = line.timestamp || new Date().toISOString();

  for (const block of line.message.content) {
    if (block.type === 'text') {
      entries.push({
        entryType: 'text',
        content: block.text,
        timestamp: ts,
        metadata: { role: 'assistant', model: line.message.model },
      });
    } else if (block.type === 'tool_use') {
      // Format tool call for display
      const inputStr = formatToolInput(block.name, block.input);
      entries.push({
        entryType: 'tool_use',
        content: inputStr,
        timestamp: ts,
        metadata: {
          role: 'assistant',
          tool_name: block.name,
          tool_use_id: block.id,
          tool_input: block.input,
        },
      });
    }
  }

  // Add token usage if present
  if (line.message.usage) {
    entries.push({
      entryType: 'system',
      content: `Tokens: ${line.message.usage.input_tokens} in / ${line.message.usage.output_tokens} out`,
      timestamp: ts,
      metadata: { usage: line.message.usage },
    });
  }

  return entries;
}

function parseSystemLine(line: { type: 'system'; subtype?: string; content?: string; timestamp?: string }): OutputEntry[] {
  if (!line.content) { return []; }
  return [{
    entryType: 'system',
    content: line.content,
    timestamp: line.timestamp || new Date().toISOString(),
    metadata: { subtype: line.subtype },
  }];
}

/**
 * Format tool input for human-readable display.
 */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return `Bash: ${input.command || ''}`;
    case 'Read':
      return `Read: ${input.file_path || ''}`;
    case 'Write':
      return `Write: ${input.file_path || ''}`;
    case 'Edit':
      return `Edit: ${input.file_path || ''}`;
    case 'Glob':
      return `Glob: ${input.pattern || ''}`;
    case 'Grep':
      return `Grep: ${input.pattern || ''}`;
    case 'Task':
      return `Task: ${input.description || ''} (${input.subagent_type || ''})`;
    case 'WebSearch':
      return `WebSearch: ${input.query || ''}`;
    case 'WebFetch':
      return `WebFetch: ${input.url || ''}`;
    default:
      return `${toolName}: ${JSON.stringify(input).slice(0, 200)}`;
  }
}

/**
 * Extract session metadata from the first few lines of a JSONL file.
 * Returns the session slug, cwd, and sessionId.
 */
export function extractSessionMeta(lines: string[]): { sessionId: string; slug: string; cwd: string } | null {
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed.sessionId && parsed.cwd) {
        return {
          sessionId: parsed.sessionId,
          slug: parsed.slug || parsed.sessionId.slice(0, 8),
          cwd: parsed.cwd,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}
