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

import * as path from 'path';
import type { ClaudeJsonlLine, ClaudeContentBlock, OutputEntry } from './types';

// --- Permission detection ---

/** Tools that require user permission in each permission mode. */
const PERMISSION_TOOLS: Record<string, Set<string>> = {
  default: new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']),
  plan: new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']),
  acceptEdits: new Set(['Bash']),
  bypassPermissions: new Set(),
};

/** Extract the permissionMode field from a raw JSONL line (only present on user entries). */
export function extractPermissionMode(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line.trim());
    if (parsed.type === 'user' && typeof parsed.permissionMode === 'string') {
      return parsed.permissionMode;
    }
  } catch { /* ignore parse errors */ }
  return undefined;
}

/** Check whether a tool requires user permission under the given permission mode. */
export function toolNeedsPermission(toolName: string, permissionMode: string): boolean {
  const tools = PERMISSION_TOOLS[permissionMode] ?? PERMISSION_TOOLS['default'];
  return tools!.has(toolName);
}

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
      if (block.name === 'ExitPlanMode') {
        // Emit plan content as markdown text entry
        const input = block.input as Record<string, unknown>;
        const plan = (input.plan as string) || '';
        if (plan) {
          entries.push({
            entryType: 'text',
            content: plan,
            timestamp: ts,
            metadata: { role: 'assistant', model: line.message.model, special: 'plan', tool_use_id: block.id },
          });
        }
        // Emit plan approval signal
        entries.push({
          entryType: 'system',
          content: 'Plan approval needed',
          timestamp: ts,
          metadata: { special: 'plan_approval', tool_use_id: block.id },
        });
      } else if (block.name === 'AskUserQuestion') {
        // Emit each question as an interactive entry
        const input = block.input as Record<string, unknown>;
        const questions = (input.questions as Array<{
          question: string;
          header?: string;
          options?: Array<{ label: string; description?: string }>;
          multiSelect?: boolean;
        }>) || [];
        for (const q of questions) {
          entries.push({
            entryType: 'system',
            content: q.question,
            timestamp: ts,
            metadata: {
              special: 'ask_question',
              tool_use_id: block.id,
              header: q.header,
              options: q.options,
              multiSelect: q.multiSelect,
            },
          });
        }
      } else {
        // Format generic tool call for display
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

/** Extract UUID v4 sessionId from a filename like `26c0ab90-…-.jsonl`. */
function extractUuidFromFilename(filePath: string): string | null {
  const basename = path.basename(filePath, '.jsonl');
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return UUID_RE.test(basename) ? basename : null;
}

/**
 * Extract session metadata from the first few lines of a JSONL file.
 * Returns the session slug, cwd, and sessionId.
 *
 * When `fallbackCwd` is provided, returns metadata even if the JSONL lines
 * only contain `sessionId` (e.g. from `queue-operation` entries that lack
 * `cwd`). This breaks the deadlock where a new session file exists but
 * Claude Code hasn't written a user/assistant line yet.
 *
 * When `filePath` is provided and content has no sessionId at all (e.g. only
 * `file-history-snapshot` lines), falls back to extracting the UUID from
 * the filename.
 */
export function extractSessionMeta(
  lines: string[],
  fallbackCwd?: string,
  filePath?: string,
): { sessionId: string; slug: string; cwd: string } | null {
  let foundSessionId: string | null = null;
  let foundSlug: string | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line.trim());
      // Best case: both sessionId and cwd present
      if (parsed.sessionId && parsed.cwd) {
        return {
          sessionId: parsed.sessionId,
          slug: parsed.slug || parsed.sessionId.slice(0, 8),
          cwd: parsed.cwd,
        };
      }
      // Remember sessionId from lines that lack cwd (e.g. queue-operation)
      if (parsed.sessionId && !foundSessionId) {
        foundSessionId = parsed.sessionId;
        foundSlug = parsed.slug || null;
      }
    } catch {
      continue;
    }
  }

  // Fallback: sessionId found but no cwd — use fallbackCwd if provided
  if (foundSessionId && fallbackCwd) {
    return {
      sessionId: foundSessionId,
      slug: foundSlug || foundSessionId.slice(0, 8),
      cwd: fallbackCwd,
    };
  }

  // Last resort: extract sessionId from UUID filename when content has no
  // sessionId at all (e.g. new sessions with only file-history-snapshot lines)
  if (!foundSessionId && filePath && fallbackCwd) {
    const filenameId = extractUuidFromFilename(filePath);
    if (filenameId) {
      return { sessionId: filenameId, slug: filenameId.slice(0, 8), cwd: fallbackCwd };
    }
  }
  return null;
}

/**
 * Extract the first human-written user message from JSONL lines.
 * Skips IDE-injected context blocks (starting with `<ide_`).
 * Returns up to 80 chars with newlines replaced by spaces, or null.
 */
export function extractFirstUserMessage(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed.type !== 'user') continue;
      const content = parsed.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'text' && block.text && !block.text.startsWith('<ide_')) {
          const text = block.text.replace(/\n/g, ' ').trim();
          if (!text) continue;
          // Skip system-like messages that aren't real user prompts
          if (text.startsWith('[') || text.startsWith('Request interrupted')) continue;
          return text.length > 80 ? text.slice(0, 77) + '...' : text;
        }
      }
    } catch { continue; }
  }
  return null;
}

/**
 * Compute project name from session cwd relative to workspace root.
 * Returns the first subdirectory if cwd is deeper than workspace root,
 * null if cwd IS the workspace root (caller should try inference),
 * or basename for non-workspace sessions.
 */
export function resolveProjectFromCwd(
  cwd: string,
  workspaceCwd: string | undefined,
): string | null {
  if (!workspaceCwd) {
    return path.basename(cwd) || cwd;
  }
  const wsNorm = workspaceCwd.replace(/\/+$/, '');
  const cwdNorm = cwd.replace(/\/+$/, '');

  // cwd is deeper than workspace — extract first subdirectory
  if (cwdNorm.startsWith(wsNorm + '/')) {
    const relative = cwdNorm.slice(wsNorm.length + 1);
    const firstSegment = relative.split('/')[0];
    if (firstSegment) { return firstSegment; }
  }

  // cwd IS the workspace root — signal that inference is needed
  if (cwdNorm === wsNorm) { return null; }

  // cwd is outside workspace entirely — use basename
  return path.basename(cwd) || cwd;
}
