/**
 * Claude Code compatibility tests.
 *
 * Validates every assumption the Codedeck Bridge makes about Claude Code's
 * JSONL format, tool names, and protocol. Run these after updating Claude Code
 * to catch breaking changes before they hit production.
 *
 * Fixture files in ./fixtures/ contain real JSONL samples from tested versions.
 * When upgrading Claude Code, capture new fixture data and add/update tests.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseJsonlLine, extractPermissionMode, extractClaudeCodeVersion, extractSessionMeta } from '../jsonlParser';
import {
  checkVersionCompat,
  NEVER_NEEDS_PERMISSION,
  PLAN_MODE_AUTO_APPROVE,
  ACCEPT_EDITS_AUTO_APPROVE,
  KNOWN_LINE_TYPES,
  PERMISSION_KEYS,
  PLAN_APPROVAL_KEYS,
  MODE_CYCLE,
} from '../compat';

// --- Fixture loading ---

function loadFixture(filename: string): string[] {
  const fixturePath = path.join(__dirname, 'fixtures', filename);
  const content = fs.readFileSync(fixturePath, 'utf8');
  return content.split('\n').filter(line => line.trim());
}

function parseFixtureLines(filename: string): Array<{ type: string; raw: string; parsed: Record<string, unknown> }> {
  return loadFixture(filename).map(line => {
    const parsed = JSON.parse(line.trim());
    return { type: parsed.type as string, raw: line, parsed };
  });
}

// --- Version compatibility ---

describe('checkVersionCompat', () => {
  it('reports tested versions as compatible', () => {
    expect(checkVersionCompat('2.1.87')).toBe('tested');
    expect(checkVersionCompat('2.1.88')).toBe('tested');
  });

  it('accepts same major.minor patch versions', () => {
    // 2.1.89 should be accepted since we tested 2.1.88
    expect(checkVersionCompat('2.1.89')).toBe('tested');
    expect(checkVersionCompat('2.1.99')).toBe('tested');
  });

  it('reports different minor/major versions as untested', () => {
    expect(checkVersionCompat('2.2.0')).toBe('untested');
    expect(checkVersionCompat('3.0.0')).toBe('untested');
  });

  it('strips build metadata', () => {
    expect(checkVersionCompat('2.1.88-linux-x64')).toBe('tested');
  });
});

// --- JSONL format validation against fixture data ---

describe('JSONL fixture format (v2.1.87)', () => {
  const lines = parseFixtureLines('v2.1.87.jsonl');

  it('all lines have a known type field', () => {
    // ai-title is unknown to the bridge but should be silently skipped
    const knownPlusSilent = new Set([...KNOWN_LINE_TYPES, 'ai-title']);
    for (const { type } of lines) {
      expect(knownPlusSilent.has(type)).toBe(true);
    }
  });

  it('user entries have required fields', () => {
    const userLines = lines.filter(l => l.type === 'user');
    expect(userLines.length).toBeGreaterThan(0);

    for (const { parsed } of userLines) {
      expect(parsed).toHaveProperty('sessionId');
      expect(parsed).toHaveProperty('cwd');
      expect(parsed).toHaveProperty('message');
      const message = parsed.message as Record<string, unknown>;
      expect(message).toHaveProperty('content');
      expect(Array.isArray(message.content)).toBe(true);
    }
  });

  it('user entries have version and permissionMode', () => {
    const userLines = lines.filter(l => l.type === 'user');
    for (const { parsed } of userLines) {
      expect(typeof parsed.version).toBe('string');
      expect(typeof parsed.permissionMode).toBe('string');
    }
  });

  it('assistant entries have message.content array', () => {
    const assistantLines = lines.filter(l => l.type === 'assistant');
    expect(assistantLines.length).toBeGreaterThan(0);

    for (const { parsed } of assistantLines) {
      const message = parsed.message as Record<string, unknown>;
      expect(message).toHaveProperty('content');
      expect(Array.isArray(message.content)).toBe(true);
    }
  });

  it('assistant entries have message.usage with token counts', () => {
    const assistantLines = lines.filter(l => l.type === 'assistant');
    for (const { parsed } of assistantLines) {
      const message = parsed.message as Record<string, unknown>;
      expect(message).toHaveProperty('usage');
      const usage = message.usage as Record<string, unknown>;
      expect(typeof usage.input_tokens).toBe('number');
      expect(typeof usage.output_tokens).toBe('number');
    }
  });

  it('text content blocks have type and text fields', () => {
    for (const { parsed } of lines.filter(l => l.type === 'user' || l.type === 'assistant')) {
      const message = parsed.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>>;
      for (const block of content) {
        if (block.type === 'text') {
          expect(typeof block.text).toBe('string');
        }
      }
    }
  });

  it('tool_use content blocks have id, name, and input', () => {
    for (const { parsed } of lines.filter(l => l.type === 'assistant')) {
      const message = parsed.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>>;
      for (const block of content) {
        if (block.type === 'tool_use') {
          expect(typeof block.id).toBe('string');
          expect(typeof block.name).toBe('string');
          expect(block.input).toBeDefined();
        }
      }
    }
  });

  it('tool_result content blocks have tool_use_id', () => {
    for (const { parsed } of lines.filter(l => l.type === 'user')) {
      const message = parsed.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>>;
      for (const block of content) {
        if (block.type === 'tool_result') {
          expect(typeof block.tool_use_id).toBe('string');
        }
      }
    }
  });

  it('queue-operation entries have sessionId', () => {
    const queueLines = lines.filter(l => l.type === 'queue-operation');
    for (const { parsed } of queueLines) {
      expect(typeof parsed.sessionId).toBe('string');
    }
  });
});

// --- Version extraction ---

describe('extractClaudeCodeVersion', () => {
  it('extracts version from user entries', () => {
    const fixtureLines = loadFixture('v2.1.87.jsonl');
    const userLine = fixtureLines.find(l => JSON.parse(l).type === 'user')!;
    expect(extractClaudeCodeVersion(userLine)).toBe('2.1.87');
  });

  it('returns undefined for non-user entries', () => {
    const fixtureLines = loadFixture('v2.1.87.jsonl');
    const assistantLine = fixtureLines.find(l => JSON.parse(l).type === 'assistant')!;
    expect(extractClaudeCodeVersion(assistantLine)).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(extractClaudeCodeVersion('not json')).toBeUndefined();
  });
});

// --- Permission mode extraction ---

describe('extractPermissionMode from fixture', () => {
  it('extracts permissionMode from user entries', () => {
    const fixtureLines = loadFixture('v2.1.87.jsonl');
    const userLine = fixtureLines.find(l => JSON.parse(l).type === 'user')!;
    expect(extractPermissionMode(userLine)).toBe('plan');
  });
});

// --- Session metadata extraction ---

describe('extractSessionMeta from fixture', () => {
  it('extracts session metadata from fixture lines', () => {
    const fixtureLines = loadFixture('v2.1.87.jsonl');
    const meta = extractSessionMeta(fixtureLines);
    expect(meta).not.toBeNull();
    expect(meta!.sessionId).toBe('ed1dbdc8-8a1c-42e0-9c4e-25749762c7e0');
    expect(meta!.cwd).toBe('/home/jeroen/VScode workspace for building nostr apps');
  });
});

// --- Parser handles fixture data end-to-end ---

describe('parseJsonlLine with fixture data', () => {
  it('parses all fixture lines without errors', () => {
    const fixtureLines = loadFixture('v2.1.87.jsonl');
    for (const line of fixtureLines) {
      // Should not throw
      const entries = parseJsonlLine(line);
      expect(Array.isArray(entries)).toBe(true);
    }
  });

  it('produces output entries for user and assistant lines', () => {
    const fixtureLines = loadFixture('v2.1.87.jsonl');
    let totalEntries = 0;
    for (const line of fixtureLines) {
      totalEntries += parseJsonlLine(line).length;
    }
    expect(totalEntries).toBeGreaterThan(0);
  });

  it('produces tool_use entries for assistant tool calls', () => {
    const fixtureLines = loadFixture('v2.1.87.jsonl');
    const allEntries = fixtureLines.flatMap(l => parseJsonlLine(l));
    const toolUses = allEntries.filter(e => e.entryType === 'tool_use');
    expect(toolUses.length).toBeGreaterThan(0);
    expect(toolUses[0].metadata?.tool_name).toBe('Read');
    expect(toolUses[0].metadata?.tool_use_id).toBeDefined();
  });

  it('produces tool_result entries for user tool results', () => {
    const fixtureLines = loadFixture('v2.1.87.jsonl');
    const allEntries = fixtureLines.flatMap(l => parseJsonlLine(l));
    const toolResults = allEntries.filter(e => e.entryType === 'tool_result');
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults[0].metadata?.tool_use_id).toBeDefined();
  });

  it('produces token usage system entries', () => {
    const fixtureLines = loadFixture('v2.1.87.jsonl');
    const allEntries = fixtureLines.flatMap(l => parseJsonlLine(l));
    const usageEntries = allEntries.filter(e => e.metadata?.usage);
    expect(usageEntries.length).toBeGreaterThan(0);
    const usage = usageEntries[0].metadata!.usage as Record<string, number>;
    expect(typeof usage.input_tokens).toBe('number');
    expect(typeof usage.output_tokens).toBe('number');
  });
});

// --- Tool name stability ---

describe('tool name sets', () => {
  it('NEVER_NEEDS_PERMISSION contains expected tools', () => {
    expect(NEVER_NEEDS_PERMISSION.has('TodoWrite')).toBe(true);
    expect(NEVER_NEEDS_PERMISSION.has('TodoRead')).toBe(true);
    expect(NEVER_NEEDS_PERMISSION.has('TaskOutput')).toBe(true);
    expect(NEVER_NEEDS_PERMISSION.has('TaskStop')).toBe(true);
  });

  it('PLAN_MODE_AUTO_APPROVE contains expected tools', () => {
    const expected = ['Read', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch',
      'AskUserQuestion', 'EnterPlanMode', 'Skill', 'Bash', 'ToolSearch'];
    for (const tool of expected) {
      expect(PLAN_MODE_AUTO_APPROVE.has(tool)).toBe(true);
    }
    // Write and Edit should NOT be in plan mode (plan = read-only)
    expect(PLAN_MODE_AUTO_APPROVE.has('Write')).toBe(false);
    expect(PLAN_MODE_AUTO_APPROVE.has('Edit')).toBe(false);
  });

  it('ACCEPT_EDITS_AUTO_APPROVE contains reads and edits but not Bash/network/agents', () => {
    // File reads and edits should be auto-approved
    for (const tool of ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ToolSearch']) {
      expect(ACCEPT_EDITS_AUTO_APPROVE.has(tool)).toBe(true);
    }
    // Bash, network, and agents should NOT be auto-approved
    for (const tool of ['Bash', 'WebSearch', 'WebFetch', 'Agent']) {
      expect(ACCEPT_EDITS_AUTO_APPROVE.has(tool)).toBe(false);
    }
  });

  it('fixture tool names are covered by the tool sets', () => {
    const fixtureLines = loadFixture('v2.1.87.jsonl');
    const allEntries = fixtureLines.flatMap(l => parseJsonlLine(l));
    const toolNames = new Set(
      allEntries
        .filter(e => e.entryType === 'tool_use')
        .map(e => e.metadata?.tool_name as string)
        .filter(Boolean)
    );

    // Every tool in the fixture should be in either NEVER_NEEDS_PERMISSION or PLAN_MODE_AUTO_APPROVE
    // or be a known tool that requires explicit permission
    for (const name of toolNames) {
      const classified = NEVER_NEEDS_PERMISSION.has(name) || PLAN_MODE_AUTO_APPROVE.has(name);
      if (!classified) {
        // Not classified — this is a new tool that should be added to one of the sets.
        // The test won't fail, but logs a warning for review.
        console.warn(`[compat] Tool "${name}" not in NEVER_NEEDS_PERMISSION or PLAN_MODE_AUTO_APPROVE — review for classification`);
      }
    }
  });
});

// --- Compat constants ---

describe('compat constants', () => {
  it('permission keys are single digits', () => {
    expect(PERMISSION_KEYS.yes).toBe('1');
    expect(PERMISSION_KEYS.always).toBe('2');
    expect(PERMISSION_KEYS.no).toBe('3');
  });

  it('plan approval keys are single digits', () => {
    expect(PLAN_APPROVAL_KEYS.approveEdits).toBe('1');
    expect(PLAN_APPROVAL_KEYS.approveManual).toBe('2');
    expect(PLAN_APPROVAL_KEYS.revise).toBe('3');
  });

  it('mode cycle has 3 modes in expected order', () => {
    expect(MODE_CYCLE).toEqual(['plan', 'default', 'acceptEdits']);
  });
});

// --- Manual validation checklist (not automated) ---
//
// After updating Claude Code, verify these manually:
//
// CLI:
//   [ ] `claude --session-id <uuid> --ide --permission-mode plan` starts successfully
//   [ ] Terminal name contains the session slug in format "(xxxxxxxx)"
//
// Terminal input:
//   [ ] Escape+Enter workaround submits text (300ms autocomplete + 100ms + Enter)
//   [ ] Permission prompt accepts '1'=yes, '2'=always, '3'=no keypresses
//   [ ] Plan approval accepts '1', '2', '3' keypresses
//   [ ] Shift+Tab (\x1b[Z) cycles through plan -> default -> acceptEdits
//
// JSONL:
//   [ ] Session file appears at ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
//   [ ] User entries have version, permissionMode, sessionId, cwd fields
//   [ ] Assistant entries have message.content with tool_use blocks (id, name, input)
//   [ ] Token usage has input_tokens and output_tokens fields
//
// Phone integration:
//   [ ] Start phone session from Codedeck -> output streams correctly
//   [ ] Permission cards appear and route keypresses correctly
//   [ ] Plan approval works (3 options: approve edits, approve yolo, revise)
//   [ ] Token usage displays on phone
