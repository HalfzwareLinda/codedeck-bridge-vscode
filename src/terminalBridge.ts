/**
 * Terminal bridge: find Claude Code terminals in VSCode and send input to them.
 *
 * Claude Code runs in VSCode terminals. We detect which terminal is running
 * Claude Code and send user input from the phone to that terminal.
 *
 * TerminalRegistry tracks the lifecycle of Claude terminals and maps
 * sessionId → terminal for input routing.
 *
 * Phone-initiated sessions use direct spawning with `claude --session-id <uuid>`
 * so the sessionId is known immediately — no detection chain needed.
 *
 * Manually opened Claude terminals are still detected via onDidOpenTerminal
 * and correlated with sessions through SessionWatcher's onNewSession callback.
 */

import * as vscode from 'vscode';

/**
 * Find VSCode terminals that are running Claude Code.
 * Claude Code terminals typically have names containing "Claude" or "claude".
 */
export function findClaudeTerminals(): vscode.Terminal[] {
  return vscode.window.terminals.filter(t => {
    const name = t.name.toLowerCase();
    return name.includes('claude') || name.includes('claude code');
  });
}

/**
 * Show a notification when no terminal is found for a session.
 */
export function notifyNoTerminal(): void {
  vscode.window.showWarningMessage(
    'Codedeck: No active terminal found for this session. The Claude Code terminal may need to be opened in VSCode.',
  );
}

/** Pending input that is waiting for a session-to-terminal mapping. */
interface PendingInput {
  text: string;
  sessionId: string;
  timestamp: number;
}

/**
 * Manages session-to-terminal mappings. Phone-initiated sessions use
 * deterministic mapping via createSession(); manually opened terminals
 * use temporal proximity matching.
 */
export class TerminalRegistry implements vscode.Disposable {
  private sessionTerminals: Map<string, vscode.Terminal> = new Map();
  private recentTerminals: Array<{ terminal: vscode.Terminal; openedAt: number }> = [];
  private disposables: vscode.Disposable[] = [];
  /** Input queued while waiting for a session-to-terminal mapping. */
  private pendingInputs: PendingInput[] = [];
  private static readonly PENDING_INPUT_TIMEOUT_MS = 30_000;
  /** Shell integration listeners pending for terminals that haven't launched claude yet. */
  private launchDisposables: Map<vscode.Terminal, vscode.Disposable[]> = new Map();
  /** Tracked timeout handles for pending input flushes (cleared on dispose). */
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  /** Guard against concurrent flushPendingInputs calls for the same session. */
  private flushingSession: Set<string> = new Set();
  /** Callback fired when queued input expires without being delivered. */
  onInputExpired?: (sessionId: string) => void;

  constructor() {
    this.disposables.push(
      vscode.window.onDidOpenTerminal(terminal => {
        if (this.isClaudeTerminal(terminal)) {
          this.recentTerminals.push({ terminal, openedAt: Date.now() });
          // Keep only last 30 seconds of recent terminals
          const cutoff = Date.now() - 30_000;
          this.recentTerminals = this.recentTerminals.filter(r => r.openedAt > cutoff);
        }
      }),
      vscode.window.onDidCloseTerminal(terminal => {
        // Remove from session mapping
        for (const [sessionId, t] of this.sessionTerminals) {
          if (t === terminal) {
            this.sessionTerminals.delete(sessionId);
            break;
          }
        }
        // Remove from recent
        this.recentTerminals = this.recentTerminals.filter(r => r.terminal !== terminal);
        // Clean up any pending shell integration listeners
        const pending = this.launchDisposables.get(terminal);
        if (pending) {
          for (const d of pending) { d.dispose(); }
          this.launchDisposables.delete(terminal);
        }
      }),
    );
  }

  /**
   * Called when a new session file is detected. Tries to associate it with
   * a recently opened Claude terminal using temporal proximity.
   *
   * For phone-spawned sessions, the mapping is already set via createSession()
   * so this is mainly for manually opened terminals.
   *
   * Also flushes any pending input queued for that session.
   */
  onNewSession(sessionId: string, cwd: string): void {
    if (this.sessionTerminals.has(sessionId)) { return; }

    // Temporal proximity matching for manually opened terminals
    const now = Date.now();
    this.recentTerminals = this.recentTerminals.filter(r => (now - r.openedAt) < 30_000);
    const candidates = this.recentTerminals.filter(r => (now - r.openedAt) < 5_000);

    let matched: vscode.Terminal | null = null;

    if (candidates.length === 1) {
      matched = candidates[0].terminal;
    } else if (candidates.length > 1) {
      // Multiple recent terminals — only match on cwd, never guess
      const cwdBasename = cwd.split('/').pop() || '';
      if (cwdBasename) {
        for (const c of candidates) {
          if (c.terminal.name.includes(cwdBasename)) {
            matched = c.terminal;
            break;
          }
        }
      }
    }

    if (matched) {
      this.sessionTerminals.set(sessionId, matched);
      this.flushPendingInputs(sessionId, matched);
    }
  }

  /**
   * Called during startup for sessions that already existed before the extension
   * activated. Matches by cwd basename without the 10-second time constraint.
   */
  mapExistingSession(sessionId: string, cwd: string): void {
    if (this.sessionTerminals.has(sessionId)) { return; }

    const claudeTerminals = findClaudeTerminals();
    if (claudeTerminals.length === 0) { return; }

    // Match by session ID slug in terminal name (phone-created terminals use this naming)
    const slug = sessionId.slice(0, 8);
    for (const t of claudeTerminals) {
      if (t.name.includes(slug)) {
        this.sessionTerminals.set(sessionId, t);
        return;
      }
    }

    // Match by cwd basename in terminal name — never blindly map all sessions to one terminal
    const cwdBasename = cwd.split('/').pop() || '';
    if (cwdBasename) {
      for (const t of claudeTerminals) {
        if (t.name.includes(cwdBasename)) {
          this.sessionTerminals.set(sessionId, t);
          return;
        }
      }
    }
    // No match — leave unmapped rather than guessing wrong
  }

  /**
   * Queue input for a session that was just relaunched. The terminal exists
   * but Claude hasn't started yet, so we can't send immediately.
   * Flushes after a delay to give Claude time to start up.
   */
  queueInputForRelaunch(sessionId: string, text: string, delayMs = 5_000): void {
    this.pendingInputs.push({ text, sessionId, timestamp: Date.now() });
    const terminal = this.sessionTerminals.get(sessionId);
    if (terminal && terminal.exitStatus === undefined) {
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        this.flushPendingInputs(sessionId, terminal);
      }, delayMs);
      this.pendingTimers.add(timer);
    }
  }

  /**
   * Close (dispose) the terminal for a session, removing the mapping.
   * Returns true if a terminal was found and closed.
   */
  closeSession(sessionId: string): boolean {
    const terminal = this.sessionTerminals.get(sessionId);
    if (!terminal) return false;
    this.sessionTerminals.delete(sessionId);
    if (terminal.exitStatus === undefined) {
      terminal.dispose();
    }
    return true;
  }

  /** Check if a session has a live (non-exited) terminal mapping. */
  hasTerminal(sessionId: string): boolean {
    const terminal = this.sessionTerminals.get(sessionId);
    return terminal !== undefined && terminal.exitStatus === undefined;
  }

  /**
   * Send Shift+Tab to cycle Claude Code's permission mode.
   * The escape sequence \x1b[Z is the standard terminal encoding for Shift+Tab.
   */
  async sendShiftTab(sessionId: string): Promise<boolean> {
    const known = this.sessionTerminals.get(sessionId);
    if (known && known.exitStatus === undefined) {
      // Ensure terminal is visible (activates PTY) without stealing keyboard focus
      known.show(false);
      known.sendText('\x1b[Z', false);
      return true;
    }
    // Recover by slug match
    const slug = sessionId.slice(0, 8);
    const claudeTerminals = findClaudeTerminals().filter(t => t.exitStatus === undefined);
    const matched = claudeTerminals.find(t => t.name.includes(slug));
    if (matched) {
      this.sessionTerminals.set(sessionId, matched);
      matched.show(false);
      matched.sendText('\x1b[Z', false);
      return true;
    }
    return false;
  }

  /**
   * Send a single raw keypress to a Claude Code terminal without the
   * Escape+Enter workaround. Used for permission prompts where Claude Code
   * reads single keypresses in raw mode (y/n/a/d).
   */
  async sendKeypress(key: string, sessionId?: string): Promise<boolean> {
    if (sessionId) {
      const known = this.sessionTerminals.get(sessionId);
      if (known && known.exitStatus === undefined) {
        console.log(`[Codedeck] sendKeypress delivered to terminal for session ${sessionId}: ${key}`);
        known.sendText(key, false);
        return true;
      }
      if (known) {
        this.sessionTerminals.delete(sessionId);
      }
    }

    const claudeTerminals = findClaudeTerminals().filter(t => t.exitStatus === undefined);

    // Fallback 1: match by session ID slug in terminal name (phone-created terminals
    // are named "Claude Code (abc12345)" — recovers mapping after extension reload)
    if (sessionId) {
      const slug = sessionId.slice(0, 8);
      const matched = claudeTerminals.find(t => t.name.includes(slug));
      if (matched) {
        console.log(`[Codedeck] sendKeypress recovered terminal by slug ${slug} for session ${sessionId}: ${key}`);
        this.sessionTerminals.set(sessionId, matched);
        matched.sendText(key, false);
        return true;
      }
    }

    // Fallback 2: single Claude terminal (best effort for manually opened sessions)
    if (claudeTerminals.length === 1) {
      console.log(`[Codedeck] sendKeypress fallback: single Claude terminal for session ${sessionId}: ${key}`);
      claudeTerminals[0].sendText(key, false);
      return true;
    }

    console.log(`[Codedeck] sendKeypress FAILED: no terminal found for session ${sessionId} (${claudeTerminals.length} Claude terminals open)`);
    return false;
  }

  /**
   * Send text input to a Claude Code terminal.
   *
   * Only sends to a terminal with a confirmed sessionId mapping.
   * If no mapping exists, queues the text for potential future matching
   * (via onNewSession temporal proximity) and returns false so the caller
   * can notify the user.
   */
  async sendText(text: string, sessionId?: string): Promise<boolean> {
    // 1. Try the known terminal for this session
    if (sessionId) {
      const known = this.sessionTerminals.get(sessionId);
      if (known && known.exitStatus === undefined) {
        console.log(`[Codedeck] sendText delivered to terminal for session ${sessionId}: ${text.slice(0, 50)}...`);
        await this.submitToTerminal(known, text);
        return true;
      }
      if (known) {
        this.sessionTerminals.delete(sessionId); // clean up dead mapping
      }
    }

    // 2. Recover by session ID slug in terminal name (phone-created terminals
    // are named "Claude Code (abc12345)" — recovers mapping after extension reload)
    if (sessionId) {
      const slug = sessionId.slice(0, 8);
      const claudeTerminals = findClaudeTerminals().filter(t => t.exitStatus === undefined);
      const matched = claudeTerminals.find(t => t.name.includes(slug));
      if (matched) {
        console.log(`[Codedeck] sendText recovered terminal by slug ${slug} for session ${sessionId}: ${text.slice(0, 50)}...`);
        this.sessionTerminals.set(sessionId, matched);
        await this.submitToTerminal(matched, text);
        return true;
      }
    }

    // 3. No mapped terminal — queue for potential future match, inform caller
    if (sessionId) {
      console.log(`[Codedeck] sendText QUEUED (no terminal mapping) for session ${sessionId}: ${text.slice(0, 50)}...`);
      this.pendingInputs.push({ text, sessionId, timestamp: Date.now() });
      this.prunePendingInputs();
      return false;
    }

    // 3. No sessionId at all — can't safely route
    return false;
  }

  /**
   * Send text directly to a Claude Code terminal, skipping the Escape key step.
   * Used for plan revision prompts where Escape would cancel the prompt entirely.
   */
  async sendTextDirect(text: string, sessionId?: string): Promise<boolean> {
    // 1. Try the known terminal for this session
    if (sessionId) {
      const known = this.sessionTerminals.get(sessionId);
      if (known && known.exitStatus === undefined) {
        console.log(`[Codedeck] sendTextDirect delivered to terminal for session ${sessionId}: ${text.slice(0, 50)}...`);
        await this.submitToTerminal(known, text, true);
        return true;
      }
      if (known) {
        this.sessionTerminals.delete(sessionId);
      }
    }

    // 2. Recover by session ID slug in terminal name
    if (sessionId) {
      const slug = sessionId.slice(0, 8);
      const claudeTerminals = findClaudeTerminals().filter(t => t.exitStatus === undefined);
      const matched = claudeTerminals.find(t => t.name.includes(slug));
      if (matched) {
        console.log(`[Codedeck] sendTextDirect recovered terminal by slug ${slug} for session ${sessionId}: ${text.slice(0, 50)}...`);
        this.sessionTerminals.set(sessionId, matched);
        await this.submitToTerminal(matched, text, true);
        return true;
      }
    }

    return false;
  }

  /**
   * Spawn a new Claude Code terminal with a specific session ID.
   *
   * Creates a terminal with the user's default shell (bash/zsh), then
   * executes `claude --session-id <uuid> --ide` inside it.
   *
   * Note: Claude Code's Ink TUI uses raw mode, so user input must go through
   * submitToTerminal() (Escape+Enter workaround), not plain sendText().
   * The initial `claude` command itself is fine via sendText/executeCommand
   * because it runs in the shell before Ink takes over.
   *
   * The terminal ↔ sessionId mapping is set deterministically at creation time.
   */
  createSession(sessionId: string, cwd?: string): vscode.Terminal {
    const command = `claude --session-id ${sessionId} --ide --permission-mode plan`;

    const terminal = vscode.window.createTerminal({
      name: `Claude Code (${sessionId.slice(0, 8)})`,
      // No shellPath — use user's default shell (bash/zsh).
      // Claude runs inside the shell, getting proper TTY line discipline.
      cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      isTransient: true,
    });

    // Deterministic mapping — no heuristics needed
    this.sessionTerminals.set(sessionId, terminal);
    terminal.show();

    // Execute claude inside the shell
    this.launchClaudeInShell(terminal, command);

    return terminal;
  }

  /**
   * Execute a command inside a terminal's shell.
   * Uses shell integration (executeCommand) when available for reliability,
   * with a 3-second timeout fallback to sendText().
   */
  private launchClaudeInShell(terminal: vscode.Terminal, command: string): void {
    let resolved = false;
    const disposables: vscode.Disposable[] = [];

    // Path 1: Shell integration available — use executeCommand
    disposables.push(
      vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal && !resolved) {
          resolved = true;
          console.log(`[Codedeck] Shell integration available, executing: ${command}`);
          e.shellIntegration.executeCommand(command);
          this.cleanupLaunchDisposables(terminal);
        }
      }),
    );

    // Path 2: Fallback after 3s — shell integration not available
    const timer = setTimeout(() => {
      if (!terminal.shellIntegration && !resolved) {
        resolved = true;
        console.log(`[Codedeck] Shell integration timeout, sendText fallback: ${command}`);
        terminal.sendText(command);
        this.cleanupLaunchDisposables(terminal);
      }
    }, 3000);
    disposables.push({ dispose: () => clearTimeout(timer) });

    this.launchDisposables.set(terminal, disposables);
  }

  /**
   * Submit text to a Claude Code terminal's Ink TUI.
   *
   * Claude Code uses Ink (React for CLIs) which puts the terminal in raw mode.
   * Ink's ink-text-input treats programmatic \n / \r as newline characters,
   * NOT as submit actions. Additionally, autocomplete intercepts Enter.
   *
   * Workaround (proven by tmux multi-agent systems):
   *   1. Type text (no newline)
   *   2. Wait 300ms for autocomplete to engage
   *   3. Send Escape to dismiss autocomplete
   *   4. Wait 100ms
   *   5. Send Enter to submit
   *
   * All steps use terminal.sendText() which targets a specific terminal
   * instance, avoiding the active-terminal routing problem of sendSequence.
   *
   * See: https://github.com/anthropics/claude-code/issues/15553
   */
  private async submitToTerminal(terminal: vscode.Terminal, text: string, skipEscape?: boolean): Promise<void> {
    // Type the text without submitting
    if (terminal.exitStatus !== undefined) { return; }
    terminal.sendText(text, false);

    if (skipEscape) {
      // Direct submit — used for plan revision prompts where Escape cancels the prompt
      await new Promise(r => setTimeout(r, 100));
      if (terminal.exitStatus !== undefined) { return; }
      terminal.sendText('\r', false);
    } else {
      // Wait for autocomplete to engage
      await new Promise(r => setTimeout(r, 300));

      // Escape to dismiss autocomplete
      if (terminal.exitStatus !== undefined) { return; }
      terminal.sendText('\x1b', false);

      // Small delay before Enter
      await new Promise(r => setTimeout(r, 100));

      // Enter to submit
      if (terminal.exitStatus !== undefined) { return; }
      terminal.sendText('\r', false);
    }
  }

  /** Clean up shell integration listeners for a terminal. */
  private cleanupLaunchDisposables(terminal: vscode.Terminal): void {
    const pending = this.launchDisposables.get(terminal);
    if (pending) {
      for (const d of pending) { d.dispose(); }
      this.launchDisposables.delete(terminal);
    }
  }

  /**
   * Flush queued inputs for a session once its terminal mapping is established.
   * Sends each input sequentially since submitToTerminal uses timed delays.
   */
  private async flushPendingInputs(sessionId: string, terminal: vscode.Terminal): Promise<void> {
    // Guard against concurrent flushes for the same session
    if (this.flushingSession.has(sessionId)) { return; }
    this.flushingSession.add(sessionId);
    try {
    const now = Date.now();
    const toSend: PendingInput[] = [];
    const remaining: PendingInput[] = [];

    for (const pending of this.pendingInputs) {
      if (pending.sessionId === sessionId && (now - pending.timestamp) < TerminalRegistry.PENDING_INPUT_TIMEOUT_MS) {
        toSend.push(pending);
      } else if ((now - pending.timestamp) < TerminalRegistry.PENDING_INPUT_TIMEOUT_MS) {
        remaining.push(pending);
      }
      // else: expired, drop and notify
      else {
        console.log(`[Codedeck] Pending input EXPIRED for session ${pending.sessionId}: ${pending.text.slice(0, 50)}...`);
        this.onInputExpired?.(pending.sessionId);
      }
    }

    this.pendingInputs = remaining;

    for (const { text } of toSend) {
      console.log(`[Codedeck] Flushing pending input to session ${sessionId}: ${text.slice(0, 50)}...`);
      await this.submitToTerminal(terminal, text);
    }
    } finally {
      this.flushingSession.delete(sessionId);
    }
  }

  /**
   * Remove expired pending inputs, notifying via onInputExpired callback.
   */
  private prunePendingInputs(): void {
    const cutoff = Date.now() - TerminalRegistry.PENDING_INPUT_TIMEOUT_MS;
    const expired = this.pendingInputs.filter(p => p.timestamp <= cutoff);
    this.pendingInputs = this.pendingInputs.filter(p => p.timestamp > cutoff);

    for (const p of expired) {
      console.log(`[Codedeck] Pending input EXPIRED for session ${p.sessionId}: ${p.text.slice(0, 50)}...`);
      this.onInputExpired?.(p.sessionId);
    }
  }

  private isClaudeTerminal(terminal: vscode.Terminal): boolean {
    const name = terminal.name.toLowerCase();
    return name.includes('claude') || name.includes('claude code');
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
    for (const disposables of this.launchDisposables.values()) {
      for (const d of disposables) { d.dispose(); }
    }
    this.launchDisposables.clear();
    for (const timer of this.pendingTimers) { clearTimeout(timer); }
    this.pendingTimers.clear();
  }
}
