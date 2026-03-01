/**
 * Terminal bridge: find Claude Code terminals in VSCode and send input to them.
 *
 * Claude Code runs in VSCode terminals. We detect which terminal is running
 * Claude Code and send user input from the phone to that terminal.
 *
 * TerminalRegistry tracks the lifecycle of Claude terminals and correlates
 * them with sessions using temporal proximity and a "remembered terminal"
 * strategy for multi-terminal scenarios.
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
 * Show a notification if no Claude Code terminal is found.
 */
export function notifyNoTerminal(): void {
  vscode.window.showWarningMessage(
    'Codedeck: No Claude Code terminal found. Start a Claude Code session in the terminal first.',
  );
}

/**
 * Get a list of terminal names for debugging/display.
 */
export function listTerminals(): string[] {
  return vscode.window.terminals.map(t => t.name);
}

/**
 * Manages session-to-terminal mappings using temporal correlation and
 * remembered-terminal strategy.
 */
export class TerminalRegistry implements vscode.Disposable {
  private sessionTerminals: Map<string, vscode.Terminal> = new Map();
  private recentTerminals: Array<{ terminal: vscode.Terminal; openedAt: number }> = [];
  private disposables: vscode.Disposable[] = [];

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
   */
  onNewSession(sessionId: string, cwd: string): void {
    if (this.sessionTerminals.has(sessionId)) { return; }

    const now = Date.now();
    // Prune stale entries while we're here
    this.recentTerminals = this.recentTerminals.filter(r => (now - r.openedAt) < 30_000);
    const candidates = this.recentTerminals.filter(r => (now - r.openedAt) < 10_000);

    if (candidates.length === 1) {
      // Only one recent Claude terminal — high confidence match
      this.sessionTerminals.set(sessionId, candidates[0].terminal);
      return;
    }

    // Try matching by cwd basename in terminal name
    const cwdBasename = cwd.split('/').pop() || '';
    if (cwdBasename) {
      for (const c of candidates) {
        if (c.terminal.name.includes(cwdBasename)) {
          this.sessionTerminals.set(sessionId, c.terminal);
          return;
        }
      }
    }
  }

  /**
   * Send text input to a Claude Code terminal.
   *
   * Priority chain:
   * 1. Known terminal for this sessionId (proactive or remembered)
   * 2. Single Claude terminal (common case)
   * 3. Active terminal if it's a Claude terminal (multi-terminal)
   * 4. First Claude terminal (fallback)
   * 5. Any active terminal (last resort)
   */
  sendText(text: string, sessionId?: string): boolean {
    const terminals = findClaudeTerminals();

    if (terminals.length === 0) {
      const activeTerminal = vscode.window.activeTerminal;
      if (activeTerminal) {
        activeTerminal.sendText(text);
        if (sessionId) { this.sessionTerminals.set(sessionId, activeTerminal); }
        return true;
      }
      return false;
    }

    // 1. Try the known terminal for this session
    if (sessionId) {
      const known = this.sessionTerminals.get(sessionId);
      if (known && terminals.includes(known)) {
        known.sendText(text);
        return true;
      }
    }

    // 2. Single terminal — use it
    if (terminals.length === 1) {
      terminals[0].sendText(text);
      if (sessionId) { this.sessionTerminals.set(sessionId, terminals[0]); }
      return true;
    }

    // 3. Multiple terminals — prefer the active one if it's a Claude terminal
    const active = vscode.window.activeTerminal;
    if (active && terminals.includes(active)) {
      active.sendText(text);
      if (sessionId) { this.sessionTerminals.set(sessionId, active); }
      return true;
    }

    // 4. Fallback — first Claude terminal
    terminals[0].sendText(text);
    if (sessionId) { this.sessionTerminals.set(sessionId, terminals[0]); }
    return true;
  }

  private isClaudeTerminal(terminal: vscode.Terminal): boolean {
    const name = terminal.name.toLowerCase();
    return name.includes('claude') || name.includes('claude code');
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
  }
}
