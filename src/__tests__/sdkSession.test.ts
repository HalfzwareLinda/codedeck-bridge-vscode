import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SdkSessionManager } from '../sdkSession';
import type { SdkSessionEvents } from '../sdkSession';
import type { OutputEntry } from '../types';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

// Mock the SDK module so createSession() doesn't spawn a real subprocess
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    // Return a mock Query that is an async generator yielding nothing
    const gen = (async function* () { /* never yields */ })();
    return Object.assign(gen, {
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    });
  }),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

function createMockEvents(): SdkSessionEvents & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    onOutput: vi.fn(),
    onPermissionRequest: vi.fn(),
    onAskQuestion: vi.fn(),
    onSessionListChanged: vi.fn(),
    onSessionEnded: vi.fn(),
    onAuthError: vi.fn(),
    onAuthSuccess: vi.fn(),
    log: (msg: string) => { logs.push(msg); },
  };
}

/**
 * Inject a question entry into a session's history AND a pending question promise.
 * Returns a promise that resolves with the PermissionResult when the question is answered.
 */
function injectQuestionHistory(
  sdk: SdkSessionManager,
  sessionId: string,
  toolUseId: string,
  options: Array<{ label: string; description?: string }>,
  header = 'question',
): Promise<PermissionResult> {
  const sessions = (sdk as any).sessions as Map<string, any>;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  session.history.push({
    seq: ++session.seqCounter,
    entry: {
      entryType: 'system',
      content: 'What should I do?',
      timestamp: new Date().toISOString(),
      metadata: {
        special: 'ask_question',
        tool_use_id: toolUseId,
        header,
        options,
        question_index: 0,
        question_count: 1,
      },
    } as OutputEntry,
  });
  // Also inject the pending question promise (mirrors handlePermission behavior)
  return new Promise<PermissionResult>((resolve) => {
    session.pendingQuestions.set(toolUseId, {
      questions: [{ question: 'What should I do?', header }],
      answers: {},
      remaining: 1,
      resolve,
    });
  });
}

/** Inject a pending permission into a session for testing resolvePermission. */
function injectPendingPermission(
  sdk: SdkSessionManager,
  sessionId: string,
  toolUseId: string,
  toolName: string,
): Promise<PermissionResult> {
  const sessions = (sdk as any).sessions as Map<string, any>;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  return new Promise<PermissionResult>((resolve) => {
    session.pendingPermissions.set(toolUseId, { toolName, resolve });
  });
}

describe('SdkSessionManager', () => {
  let sdk: SdkSessionManager;
  let events: ReturnType<typeof createMockEvents>;
  const SESSION_ID = 'test-session-001';

  beforeEach(() => {
    events = createMockEvents();
    sdk = new SdkSessionManager(events);
    sdk.createSession(SESSION_ID, '/tmp/test', 'plan');
  });

  describe('resolveQuestionKeypress', () => {
    it('maps keypress to correct option and resolves promise with answer', async () => {
      const resultPromise = injectQuestionHistory(sdk, SESSION_ID, 'tool_q1', [
        { label: 'Option A' },
        { label: 'Option B' },
        { label: 'Option C' },
      ], 'Approach');

      const sent = sdk.resolveQuestionKeypress(SESSION_ID, '2');
      expect(sent).toBe(true);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      if (result.behavior === 'allow') {
        expect(result.updatedInput).toEqual({ answers: { Approach: 'Option B' } });
      }

      const sessions = (sdk as any).sessions as Map<string, any>;
      expect(sessions.get(SESSION_ID).answeredQuestions.has('tool_q1')).toBe(true);
    });

    it('returns false for key out of range', () => {
      injectQuestionHistory(sdk, SESSION_ID, 'tool_q2', [
        { label: 'Only option' },
      ]);

      const result = sdk.resolveQuestionKeypress(SESSION_ID, '5');
      expect(result).toBe(false);
    });

    it('returns false when no pending question exists', () => {
      const result = sdk.resolveQuestionKeypress(SESSION_ID, '1');
      expect(result).toBe(false);
    });

    it('skips already-answered questions and finds the next one', async () => {
      // First question (already answered)
      injectQuestionHistory(sdk, SESSION_ID, 'tool_q_old', [
        { label: 'Old option' },
      ]);
      // Mark as answered (remove from pendingQuestions too)
      const sessions = (sdk as any).sessions as Map<string, any>;
      sessions.get(SESSION_ID).answeredQuestions.add('tool_q_old');
      sessions.get(SESSION_ID).pendingQuestions.delete('tool_q_old');

      // Second question (pending)
      const resultPromise = injectQuestionHistory(sdk, SESSION_ID, 'tool_q_new', [
        { label: 'New A' },
        { label: 'New B' },
      ], 'Method');

      const sent = sdk.resolveQuestionKeypress(SESSION_ID, '1');
      expect(sent).toBe(true);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      if (result.behavior === 'allow') {
        expect(result.updatedInput).toEqual({ answers: { Method: 'New A' } });
      }
    });

    it('returns false for non-existent session', () => {
      const result = sdk.resolveQuestionKeypress('nonexistent', '1');
      expect(result).toBe(false);
    });
  });

  describe('sendQuestionInput', () => {
    it('resolves pending question promise with free-text answer', async () => {
      const resultPromise = injectQuestionHistory(sdk, SESSION_ID, 'tool_qt1', [
        { label: 'Option A' },
      ], 'Library');

      const sent = sdk.sendQuestionInput(SESSION_ID, 'Use axios instead');
      expect(sent).toBe(true);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      if (result.behavior === 'allow') {
        expect(result.updatedInput).toEqual({ answers: { Library: 'Use axios instead' } });
      }
    });

    it('falls back to sendInput when no pending question exists', () => {
      const sent = sdk.sendQuestionInput(SESSION_ID, 'hello');
      // sendInput returns true if session exists
      expect(sent).toBe(true);
      expect(events.logs.some(l => l.includes('falling back to sendInput'))).toBe(true);
    });
  });

  describe('setEffortLevel', () => {
    it('passes through low/medium/high directly', async () => {
      for (const level of ['low', 'medium', 'high'] as const) {
        const result = await sdk.setEffortLevel(SESSION_ID, level);
        expect(result.applied).toBe(true);
        expect(result.confirmedLevel).toBe(level);
      }
    });

    it('maps max to high but confirms as max', async () => {
      const result = await sdk.setEffortLevel(SESSION_ID, 'max');
      expect(result.applied).toBe(true);
      expect(result.confirmedLevel).toBe('max');
    });

    it('maps auto to undefined (reset to model default)', async () => {
      const result = await sdk.setEffortLevel(SESSION_ID, 'auto');
      expect(result.applied).toBe(true);
      expect(result.confirmedLevel).toBe('auto');
    });

    it('returns false for non-existent session', async () => {
      const result = await sdk.setEffortLevel('nonexistent', 'high');
      expect(result.applied).toBe(false);
    });
  });

  describe('resolvePermission', () => {
    it('resolves allow without modifier — no updatedPermissions', async () => {
      const resultPromise = injectPendingPermission(sdk, SESSION_ID, 'tool_01', 'Bash');
      sdk.resolvePermission(SESSION_ID, 'tool_01', true);
      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      expect('updatedPermissions' in result && result.updatedPermissions).toBeFalsy();
    });

    it('resolves allow with always — includes addRules for projectSettings', async () => {
      const resultPromise = injectPendingPermission(sdk, SESSION_ID, 'tool_02', 'Bash');
      sdk.resolvePermission(SESSION_ID, 'tool_02', true, 'always');
      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      if (result.behavior === 'allow') {
        expect(result.updatedPermissions).toBeDefined();
        expect(result.updatedPermissions!.length).toBe(1);
        const rule = result.updatedPermissions![0];
        expect(rule.type).toBe('addRules');
        if (rule.type === 'addRules') {
          expect(rule.rules[0].toolName).toBe('Bash');
          expect(rule.behavior).toBe('allow');
          expect(rule.destination).toBe('projectSettings');
        }
      }
    });

    it('resolves deny with never modifier', async () => {
      const resultPromise = injectPendingPermission(sdk, SESSION_ID, 'tool_03', 'Bash');
      sdk.resolvePermission(SESSION_ID, 'tool_03', false, 'never');
      const result = await resultPromise;
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toContain('never');
      }
    });

    it('resolves deny without modifier', async () => {
      const resultPromise = injectPendingPermission(sdk, SESSION_ID, 'tool_04', 'Bash');
      sdk.resolvePermission(SESSION_ID, 'tool_04', false);
      const result = await resultPromise;
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toBe('User denied');
      }
    });
  });
});
