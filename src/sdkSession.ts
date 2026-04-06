/**
 * SDK Session Manager — replaces TerminalBridge + SessionWatcher.
 *
 * Each phone-created session spawns a Claude Code subprocess via the Agent SDK's
 * query() function. Communication is structured JSON over stdin/stdout — no
 * terminal emulation, no JSONL file watching, no keystroke simulation.
 *
 * Permissions are handled via the SDK's canUseTool callback, which blocks
 * execution until the bridge responds (either auto-approve or phone response).
 */

import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  SDKSystemMessage,
  PermissionResult,
  PermissionUpdate,
  PermissionMode,
  CanUseTool,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import type { OutputEntry, RemoteSessionInfo } from './types';
import { sdkMessageToEntries } from './sdkAdapter';

// --- Async input generator ---

/** Creates a controllable async generator that yields SDKUserMessage objects.
 *  Call push() to queue a message, and the generator will yield it. */
function createInputChannel(): {
  generator: AsyncGenerator<SDKUserMessage, void>;
  push: (msg: SDKUserMessage) => void;
  close: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let resolve: (() => void) | null = null;
  let closed = false;

  const generator = (async function* () {
    while (!closed) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>(r => { resolve = r; });
        resolve = null;
      }
    }
  })();

  return {
    generator,
    push(msg: SDKUserMessage) {
      queue.push(msg);
      resolve?.();
    },
    close() {
      closed = true;
      resolve?.();
    },
  };
}

// --- Permission request forwarding ---

export interface PermissionRequest {
  sessionId: string;
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  title?: string;
  description?: string;
  resolve: (result: PermissionResult) => void;
}

export interface SdkSessionEvents {
  /** Called when new output entries are available for a session. */
  onOutput: (sessionId: string, entries: Array<{ seq: number; entry: OutputEntry }>) => void;
  /** Called when a permission request needs phone approval (not auto-approved). */
  onPermissionRequest: (request: PermissionRequest) => void;
  /** Called when an AskUserQuestion tool is invoked — forward to phone. */
  onAskQuestion: (sessionId: string, toolUseId: string, questions: unknown[]) => void;
  /** Called when the session list changes (session started, ended, etc.). */
  onSessionListChanged: (sessions: RemoteSessionInfo[]) => void;
  /** Called when a session subprocess exits. */
  onSessionEnded: (sessionId: string) => void;
  /** Called when authentication fails. */
  onAuthError: (sessionId: string, error: string) => void;
  /** Called when a session is successfully authenticated (init message received). */
  onAuthSuccess: (sessionId: string, info: { model: string; apiKeySource: string; version: string }) => void;
  /** Log function. */
  log: (msg: string) => void;
}

interface ManagedSession {
  query: Query;
  input: ReturnType<typeof createInputChannel>;
  abortController: AbortController;
  seqCounter: number;
  cwd: string;
  permissionMode: PermissionMode;
  /** Output entries history for catch-up. */
  history: Array<{ seq: number; entry: OutputEntry }>;
  /** Pending permission requests awaiting phone response, keyed by toolUseId. */
  pendingPermissions: Map<string, { toolName: string; resolve: (result: PermissionResult) => void }>;
  /** Pending AskUserQuestion options, keyed by toolUseId. Stores option labels for keypress→text mapping. */
  pendingQuestions: Map<string, Array<{ label: string; description?: string }>>;
  /** Timestamp of last activity. */
  lastActivity: string;
  /** Title extracted from first user message. */
  title: string | null;
  /** Whether the session is still running. */
  alive: boolean;
  /** Number of times this session has been auto-restarted after crash. */
  restartCount: number;
}

export class SdkSessionManager {
  private static readonly MAX_RESTARTS = 2;

  private sessions = new Map<string, ManagedSession>();
  private events: SdkSessionEvents;

  constructor(events: SdkSessionEvents) {
    this.events = events;
  }

  /** Create a new Claude Code session via the Agent SDK. */
  createSession(sessionId: string, cwd: string, initialPermissionMode: PermissionMode = 'plan'): void {
    if (this.sessions.has(sessionId)) {
      this.events.log(`[SDK] Session ${sessionId} already exists`);
      return;
    }

    const input = createInputChannel();
    const abortController = new AbortController();

    const session: ManagedSession = {
      query: undefined as unknown as Query, // Set below
      input,
      abortController,
      seqCounter: 0,
      cwd,
      permissionMode: initialPermissionMode,
      history: [],
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      lastActivity: new Date().toISOString(),
      title: null,
      alive: true,
      restartCount: 0,
    };

    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      return this.handlePermission(sessionId, session, toolName, toolInput, options);
    };

    const options: Options = {
      sessionId,
      cwd,
      permissionMode: initialPermissionMode,
      abortController,
      canUseTool,
      settingSources: ['user', 'project'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
    };

    const q = query({ prompt: input.generator, options });
    session.query = q;
    this.sessions.set(sessionId, session);

    // Start consuming messages in background
    this.consumeMessages(sessionId, session, q);
    this.events.log(`[SDK] Session ${sessionId} created in ${cwd}`);
  }

  /** Send user text input to a session. Returns true if session exists. */
  sendInput(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) { return false; }

    session.lastActivity = new Date().toISOString();

    // Extract title from first user message
    if (!session.title) {
      const cleaned = text.replace(/\n/g, ' ').trim();
      if (cleaned && !cleaned.startsWith('[') && !cleaned.startsWith('Request interrupted')) {
        session.title = cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
      }
    }

    session.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    return true;
  }

  /** Resolve a pending permission request from the phone. */
  resolvePermission(sessionId: string, toolUseId: string, allow: boolean, modifier?: 'always' | 'never'): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }

    const pending = session.pendingPermissions.get(toolUseId);
    if (!pending) {
      this.events.log(`[SDK] No pending permission for ${toolUseId} in ${sessionId}`);
      return;
    }

    session.pendingPermissions.delete(toolUseId);

    if (allow) {
      const result: PermissionResult = { behavior: 'allow', updatedInput: {} };
      // "Always allow" → persist as a session-scoped allow rule for this tool
      if (modifier === 'always') {
        const rule: PermissionUpdate = {
          type: 'addRules',
          rules: [{ toolName: pending.toolName }],
          behavior: 'allow',
          destination: 'session',
        };
        result.updatedPermissions = [rule];
      }
      pending.resolve(result);
    } else {
      pending.resolve({ behavior: 'deny', message: modifier === 'never' ? 'User denied (never ask again)' : 'User denied' });
    }
  }

  /** Change the permission mode for a session. */
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) { return false; }

    try {
      await session.query.setPermissionMode(mode);
      session.permissionMode = mode;
      this.events.log(`[SDK] Permission mode set to ${mode} for ${sessionId}`);
      return true;
    } catch (err) {
      this.events.log(`[SDK] Failed to set permission mode for ${sessionId}: ${err}`);
      return false;
    }
  }

  /** Change the effort level for a session. */
  async setEffortLevel(sessionId: string, effort: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) { return false; }

    // Map phone effort levels to SDK-compatible values.
    // SDK applyFlagSettings only accepts 'low' | 'medium' | 'high'.
    // Phone also sends 'max' and 'auto' which need mapping.
    let sdkEffort: 'low' | 'medium' | 'high';
    switch (effort) {
      case 'low':
      case 'medium':
      case 'high':
        sdkEffort = effort;
        break;
      case 'max':
        sdkEffort = 'high';
        this.events.log(`[SDK] Mapping effort 'max' → 'high' for ${sessionId}`);
        break;
      default:
        // 'auto' or unknown — skip, let SDK use its default
        this.events.log(`[SDK] Unsupported effort level '${effort}' for ${sessionId} — ignoring`);
        return false;
    }

    try {
      await session.query.applyFlagSettings({ effortLevel: sdkEffort });
      this.events.log(`[SDK] Effort level set to ${sdkEffort} for ${sessionId}`);
      return true;
    } catch (err) {
      this.events.log(`[SDK] Failed to set effort level for ${sessionId}: ${err}`);
      return false;
    }
  }

  /** Close a session. */
  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) { return false; }

    session.alive = false;
    session.input.close();
    session.abortController.abort();

    // Reject any pending permissions
    for (const [, pending] of session.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'Session closed' });
    }
    session.pendingPermissions.clear();

    this.sessions.delete(sessionId);
    this.events.log(`[SDK] Session ${sessionId} closed`);
    return true;
  }

  /** Get the current session list. */
  getSessions(): RemoteSessionInfo[] {
    const sessions: RemoteSessionInfo[] = [];
    for (const [id, s] of this.sessions) {
      if (!s.alive) continue;
      sessions.push({
        id,
        slug: `session-${id.slice(0, 8)}`,
        cwd: s.cwd,
        lastActivity: s.lastActivity,
        lineCount: s.seqCounter,
        title: s.title,
        project: s.cwd.split('/').pop() || s.cwd,
        hasTerminal: true, // SDK sessions are always "alive"
        permissionMode: s.permissionMode as 'default' | 'acceptEdits' | 'plan',
      });
    }
    return sessions;
  }

  /** Get history entries for a session (in-memory). */
  getHistory(sessionId: string, afterSeq?: number): Array<{ seq: number; entry: OutputEntry }> {
    const session = this.sessions.get(sessionId);
    if (!session) { return []; }
    if (afterSeq === undefined || afterSeq === 0) {
      return session.history.slice();
    }
    return session.history.filter(e => e.seq > afterSeq);
  }

  /**
   * Get history from SDK's persistent JSONL storage.
   * Falls back to this when in-memory history is empty (e.g. after extension reload).
   */
  async getPersistedHistory(sessionId: string, cwd?: string): Promise<Array<{ seq: number; entry: OutputEntry }>> {
    try {
      const messages = await getSessionMessages(sessionId, {
        dir: cwd,
        includeSystemMessages: true,
      });

      const entries: Array<{ seq: number; entry: OutputEntry }> = [];
      let seq = 0;
      for (const msg of messages) {
        // Convert SessionMessage to OutputEntry via sdkAdapter
        const sdkMsg = { ...msg, session_id: sessionId } as SDKMessage;
        const converted = sdkMessageToEntries(sdkMsg);
        for (const entry of converted) {
          entries.push({ seq: ++seq, entry });
        }
      }
      return entries;
    } catch (err) {
      this.events.log(`[SDK] Failed to load persisted history for ${sessionId}: ${err}`);
      return [];
    }
  }

  getHistoryCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.history.length ?? 0;
  }

  getPermissionMode(sessionId: string): PermissionMode | undefined {
    return this.sessions.get(sessionId)?.permissionMode;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Resolve a question option selection by keypress number (1-based).
   * Looks up the stored question options and sends the option label as input.
   * Returns true if the answer was sent.
   */
  resolveQuestionKeypress(sessionId: string, key: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) return false;

    const keyNum = parseInt(key, 10);
    if (isNaN(keyNum) || keyNum < 1) return false;

    // Find the first pending question that has options matching this key
    for (const [toolUseId, options] of session.pendingQuestions) {
      if (keyNum <= options.length) {
        const selected = options[keyNum - 1];
        session.pendingQuestions.delete(toolUseId);
        // Send the option label as user input — the SDK routes it to the pending AskUserQuestion
        return this.sendInput(sessionId, selected.label);
      }
    }

    this.events.log(`[SDK] No pending question for keypress '${key}' in ${sessionId}`);
    return false;
  }

  /** Dispose all sessions. */
  dispose(): void {
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
  }

  // --- Internal ---

  /** Consume SDK messages and forward as OutputEntry to the Nostr relay. */
  private async consumeMessages(sessionId: string, session: ManagedSession, q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        if (!session.alive) break;

        // Auth error detection: SDK emits auth_status with error field on failure
        if (msg.type === 'auth_status') {
          const authMsg = msg as import('@anthropic-ai/claude-agent-sdk').SDKAuthStatusMessage;
          if (authMsg.error) {
            this.events.log(`[SDK] Auth error for ${sessionId}: ${authMsg.error}`);
            this.events.onAuthError(sessionId, authMsg.error);
          }
          continue; // Don't forward auth_status to phone
        }

        // Auth success detection: init message means Claude Code is running
        if (msg.type === 'system' && (msg as SDKSystemMessage).subtype === 'init') {
          const sysMsg = msg as SDKSystemMessage;
          session.permissionMode = sysMsg.permissionMode;
          this.events.onAuthSuccess(sessionId, {
            model: sysMsg.model,
            apiKeySource: sysMsg.apiKeySource,
            version: sysMsg.claude_code_version,
          });
          this.events.onSessionListChanged(this.getSessions());
        }

        const entries = sdkMessageToEntries(msg);
        if (entries.length === 0) continue;

        const seqEntries = entries.map(entry => ({
          seq: ++session.seqCounter,
          entry,
        }));

        // Store in history (cap at 500)
        session.history.push(...seqEntries);
        if (session.history.length > 500) {
          session.history = session.history.slice(-500);
        }

        session.lastActivity = new Date().toISOString();
        this.events.onOutput(sessionId, seqEntries);
      }
    } catch (err) {
      if (!session.alive) return; // Intentional close, don't restart

      this.events.log(`[SDK] Session ${sessionId} message stream error: ${err}`);

      // Attempt auto-restart if under the retry limit
      if (session.restartCount < SdkSessionManager.MAX_RESTARTS) {
        session.restartCount++;
        this.events.log(`[SDK] Restarting session ${sessionId} (attempt ${session.restartCount}/${SdkSessionManager.MAX_RESTARTS})`);

        // Notify phone that we're restarting
        const restartEntry: OutputEntry = {
          entryType: 'system',
          content: `Session interrupted — restarting (attempt ${session.restartCount})...`,
          timestamp: new Date().toISOString(),
          metadata: { special: 'session_restart' },
        };
        this.events.onOutput(sessionId, [{ seq: ++session.seqCounter, entry: restartEntry }]);

        // Re-create input channel and query with resume
        const newInput = createInputChannel();
        const newAbort = new AbortController();
        session.input = newInput;
        session.abortController = newAbort;

        const newQ = query({
          prompt: newInput.generator,
          options: {
            resume: sessionId,
            cwd: session.cwd,
            permissionMode: session.permissionMode,
            abortController: newAbort,
            canUseTool: async (toolName, toolInput, options) => {
              return this.handlePermission(sessionId, session, toolName, toolInput, options);
            },
            settingSources: ['user', 'project'],
            systemPrompt: { type: 'preset', preset: 'claude_code' },
            tools: { type: 'preset', preset: 'claude_code' },
          },
        });
        session.query = newQ;

        // Resume consuming messages
        this.consumeMessages(sessionId, session, newQ);
        return; // Don't fall through to cleanup
      }

      // Max restarts exceeded — give up
      this.events.log(`[SDK] Session ${sessionId} failed after ${session.restartCount} restarts`);
      const errorEntry: OutputEntry = {
        entryType: 'error',
        content: 'Session ended unexpectedly after multiple restart attempts.',
        timestamp: new Date().toISOString(),
        metadata: { special: 'session_died' },
      };
      this.events.onOutput(sessionId, [{ seq: ++session.seqCounter, entry: errorEntry }]);
    } finally {
      // Only clean up if we're not restarting (session still in map = restart happened)
      if (this.sessions.has(sessionId) && !session.alive) {
        this.sessions.delete(sessionId);
        this.events.onSessionEnded(sessionId);
        this.events.onSessionListChanged(this.getSessions());
        this.events.log(`[SDK] Session ${sessionId} ended`);
      } else if (!this.sessions.has(sessionId)) {
        // Session was already removed (e.g. closeSession called during restart)
        this.events.onSessionEnded(sessionId);
        this.events.onSessionListChanged(this.getSessions());
        this.events.log(`[SDK] Session ${sessionId} ended`);
      }
    }
  }

  /**
   * Handle a permission request from the SDK.
   *
   * The SDK only calls canUseTool for tools that actually need approval given
   * the current permissionMode. We don't re-implement permission logic here —
   * just forward to the phone for manual approval, or auto-allow AskUserQuestion
   * (which is answered via the input channel, not via permission response).
   */
  private handlePermission(
    sessionId: string,
    session: ManagedSession,
    toolName: string,
    toolInput: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    // AskUserQuestion: always allow — the answer comes via sendInput(), not permission response
    if (toolName === 'AskUserQuestion') {
      const questions = (toolInput.questions as unknown[]) || [];
      this.events.onAskQuestion(sessionId, options.toolUseID, questions);

      // Store options so we can map keypress numbers back to option labels
      if (questions.length > 0) {
        const firstQ = questions[0] as { options?: Array<{ label: string; description?: string }> };
        if (firstQ.options && firstQ.options.length > 0) {
          session.pendingQuestions.set(options.toolUseID, firstQ.options);
        }
      }

      return Promise.resolve({ behavior: 'allow', updatedInput: {} });
    }

    // Default mode = YOLO: auto-approve everything (matches old bridge behavior
    // where the bridge simulated pressing '1' for every permission prompt)
    const mode = session.permissionMode;
    if (mode === 'default') {
      return Promise.resolve({ behavior: 'allow', updatedInput: {} });
    }

    // Plan / acceptEdits: forward to phone for manual approval
    return new Promise<PermissionResult>((resolve) => {
      session.pendingPermissions.set(options.toolUseID, { toolName, resolve });

      this.events.onPermissionRequest({
        sessionId,
        toolName,
        toolUseId: options.toolUseID,
        toolInput,
        title: options.title,
        description: options.description,
        resolve,
      });
    });
  }
}
