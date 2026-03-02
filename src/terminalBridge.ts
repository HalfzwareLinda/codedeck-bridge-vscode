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
 * Show a notification when auto-open fails (e.g., Claude Code extension not installed).
 */
export function notifyNoTerminal(): void {
  vscode.window.showWarningMessage(
    'Codedeck: Could not open a Claude Code terminal. Is the Claude Code extension installed?',
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
  private autoOpenInProgress = false;
  /** Input queued while waiting for a session-to-terminal mapping. */
  private pendingInputs: PendingInput[] = [];
  private static readonly PENDING_INPUT_TIMEOUT_MS = 30_000;

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
   * If no mapping exists, opens a new Claude Code terminal and queues
   * the text until SessionWatcher correlates the session.
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

    // 2. No mapped terminal — open a new one and queue the text
    if (sessionId) {
      this.pendingInputs.push({ text, sessionId, timestamp: Date.now() });
      this.prunePendingInputs();
      await this.ensureClaudeTerminal();
      return true;
    }

    // 3. No sessionId at all — can't safely route
    return false;
  }

  /**
   * Spawn a new Claude Code terminal with a specific session ID.
   * Uses direct `claude --session-id <uuid>` spawning so the sessionId
   * is known immediately — no detection chain needed.
   *
   * The terminal ↔ sessionId mapping is set deterministically at creation time.
   */
  createSession(sessionId: string, cwd?: string): vscode.Terminal {
    const args = ['--session-id', sessionId, '--ide'];

    const terminal = vscode.window.createTerminal({
      name: `Claude Code (${sessionId.slice(0, 8)})`,
      shellPath: 'claude',
      shellArgs: args,
      cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });

    // Deterministic mapping — no heuristics needed
    this.sessionTerminals.set(sessionId, terminal);
    terminal.show();

    return terminal;
  }

  /**
   * Open a Claude Code terminal if one isn't already being opened.
   * Guards against concurrent opens from rapid messages.
   */
  private async ensureClaudeTerminal(): Promise<void> {
    if (this.autoOpenInProgress) { return; }

    this.autoOpenInProgress = true;
    try {
      await vscode.commands.executeCommand('claude-vscode.terminal.open');
      // Don't send text here — wait for SessionWatcher to detect the new
      // JSONL session and call onNewSession(), which flushes pending inputs.
    } catch (err) {
      console.error('[Codedeck] Failed to open Claude Code terminal:', err);
    } finally {
      this.autoOpenInProgress = false;
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
  }
}
