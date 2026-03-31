/**
 * Claude Code compatibility layer.
 *
 * Centralizes every assumption the Codedeck Bridge makes about Claude Code's
 * internals: JSONL format, CLI flags, terminal input protocol, permission
 * keypresses, tool names, and file paths.
 *
 * When Claude Code updates, this is the single file to review and update.
 * Run the compatibility test suite (claudeCodeCompat.test.ts) after updating.
 */

// --- Version tracking ---

export const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

/** Versions that have been tested with this bridge version. */
export const TESTED_VERSIONS = ['2.1.37', '2.1.87', '2.1.88'];

/** Highest version confirmed working. */
export const MAX_TESTED_VERSION = '2.1.88';

/**
 * Check if a Claude Code version has been tested with this bridge.
 * Returns 'tested' for known versions, 'untested' for unknown ones.
 */
export function checkVersionCompat(version: string): 'tested' | 'untested' {
  // Strip any build metadata (e.g. "2.1.88-linux-x64" → "2.1.88")
  const normalized = version.replace(/-.*$/, '');
  if (TESTED_VERSIONS.includes(normalized)) {
    return 'tested';
  }
  // Accept patch versions within the same minor (e.g. 2.1.89 when max is 2.1.88)
  const [maxMajor, maxMinor] = MAX_TESTED_VERSION.split('.').map(Number);
  const parts = normalized.split('.').map(Number);
  if (parts.length >= 2 && parts[0] === maxMajor && parts[1] === maxMinor) {
    return 'tested'; // same major.minor, likely compatible
  }
  return 'untested';
}

// --- JSONL line types ---

/** Line types the bridge knows how to handle. Unknown types are silently skipped. */
export const KNOWN_LINE_TYPES = new Set([
  'user', 'assistant', 'system', 'progress', 'queue-operation', 'file-history-snapshot',
]);

// --- CLI interface ---

/** Command used to spawn Claude Code sessions. */
export const CLI_COMMAND = 'claude';

/** Flags passed when spawning a phone-initiated session. */
export const CLI_SPAWN_FLAGS = ['--session-id', '--ide', '--permission-mode', 'plan'] as const;

// --- Terminal input protocol (Ink TUI) ---

/** Delay (ms) after typing text before sending Escape to dismiss autocomplete. */
export const AUTOCOMPLETE_DELAY_MS = 300;

/** Delay (ms) after Escape before sending Enter to submit. */
export const POST_ESCAPE_DELAY_MS = 100;

/** Escape sequence for Shift+Tab (mode cycling). */
export const SHIFT_TAB_SEQUENCE = '\x1b[Z';

// --- Permission prompt keypresses ---

export const PERMISSION_KEYS = {
  yes: '1',
  always: '2',
  no: '3',
} as const;

// --- Plan approval keypresses ---

export const PLAN_APPROVAL_KEYS = {
  /** Approve — auto-accept edits (mode → acceptEdits). */
  approveEdits: '1',
  /** Approve — manual edits (mode → default). */
  approveManual: '2',
  /** Revise plan (stays in plan mode, next input skips Escape). */
  revise: '3',
} as const;

// --- Permission mode cycle ---

/** The order Claude Code cycles through modes on Shift+Tab. */
export const MODE_CYCLE = ['plan', 'default', 'acceptEdits'] as const;

// --- Effort levels ---

/** Available effort levels for Claude Code's `/effort` command. */
export const EFFORT_LEVELS = ['auto', 'low', 'medium', 'high', 'max'] as const;

// --- Tool classification ---

/** Truly internal bookkeeping tools that Claude Code never prompts for
 *  under any permission configuration. Everything else is assumed to
 *  potentially prompt. The bridge uses same-batch detection (tool_use +
 *  tool_result in the same poll batch → auto-approved → skip injection)
 *  to avoid generating unnecessary permission_request events for tools
 *  like Read/Glob/Grep that are normally auto-approved but CAN be
 *  configured to require permission via custom rules. */
export const NEVER_NEEDS_PERMISSION = new Set([
  'TodoWrite', 'TodoRead', 'TaskOutput', 'TaskStop',
]);

/** Tools that are safe to auto-approve when in plan mode.
 *  Plan mode restricts Claude to read-only tools at the model level,
 *  so any tool it invokes during planning is safe to approve automatically.
 *  This lets the planning phase run uninterrupted without prompting the user. */
export const PLAN_MODE_AUTO_APPROVE = new Set([
  'Read', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch',
  'AskUserQuestion', 'EnterPlanMode', 'Skill',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput',
  'Bash', 'Write', 'Edit', 'ToolSearch',
]);

// --- File paths ---

/** Base directory where Claude Code stores session JSONL files. */
export const SESSION_DIR_BASE = '.claude/projects';

// --- Terminal naming ---

/** Regex to extract the 8-char session slug from a terminal name like "Claude Code (abc12345)". */
export const TERMINAL_SLUG_PATTERN = /\(([0-9a-f]{8})\)/i;
