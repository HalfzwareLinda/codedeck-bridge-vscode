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
    const candidates = this.recentTerminals.filter(r => (now - r.openedAt) < 10_000);

    let matched: vscode.Terminal | null = null;

    if (candidates.length === 1) {
      matched = candidates[0].terminal;
    } else {
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

    // Single terminal — high confidence match
    if (claudeTerminals.length === 1) {
      this.sessionTerminals.set(sessionId, claudeTerminals[0]);
      return;
    }

    // Multiple terminals — try matching by cwd basename in terminal name
    const cwdBasename = cwd.split('/').pop() || '';
    if (cwdBasename) {
      for (const t of claudeTerminals) {
        if (t.name.includes(cwdBasename)) {
          this.sessionTerminals.set(sessionId, t);
          return;
        }
      }
    }
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
        known.sendText(text + '\r', false);
        return true;
      }
      if (known) {
        this.sessionTerminals.delete(sessionId); // clean up dead mapping
      }
    }

    // 2. No mapped terminal — queue for potential future match, inform caller
    if (sessionId) {
      this.pendingInputs.push({ text, sessionId, timestamp: Date.now() });
      this.prunePendingInputs();
      return false;
    }

    // 3. No sessionId at all — can't safely route
    return false;
  }

  /**
   * Spawn a new Claude Code terminal with a specific session ID.
   *
   * Creates a terminal with the user's default shell (bash/zsh), then
   * executes `claude --session-id <uuid> --ide` inside it. This ensures
   * proper TTY line discipline so that sendText() input is submitted
   * correctly (the shell translates \n → \r for the child process).
   *
   * The terminal ↔ sessionId mapping is set deterministically at creation time.
   */
  createSession(sessionId: string, cwd?: string): vscode.Terminal {
    const command = `claude --session-id ${sessionId} --ide`;

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
   */
  private flushPendingInputs(sessionId: string, terminal: vscode.Terminal): void {
    const now = Date.now();
    const toSend: PendingInput[] = [];
    const remaining: PendingInput[] = [];

    for (const pending of this.pendingInputs) {
      if (pending.sessionId === sessionId && (now - pending.timestamp) < TerminalRegistry.PENDING_INPUT_TIMEOUT_MS) {
        toSend.push(pending);
      } else if ((now - pending.timestamp) < TerminalRegistry.PENDING_INPUT_TIMEOUT_MS) {
        remaining.push(pending);
      }
      // else: expired, drop silently
    }

    this.pendingInputs = remaining;

    for (const { text } of toSend) {
      console.log(`[Codedeck] Flushing pending input to session ${sessionId}: ${text.slice(0, 50)}...`);
      terminal.sendText(text + '\r', false);
    }
  }

  /**
   * Remove expired pending inputs.
   */
  private prunePendingInputs(): void {
    const cutoff = Date.now() - TerminalRegistry.PENDING_INPUT_TIMEOUT_MS;
    this.pendingInputs = this.pendingInputs.filter(p => p.timestamp > cutoff);
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
  }
}
