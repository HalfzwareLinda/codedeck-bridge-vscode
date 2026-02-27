/**
 * Terminal bridge: find Claude Code terminals in VSCode and send input to them.
 *
 * Claude Code runs in VSCode terminals. We detect which terminal is running
 * Claude Code and send user input from the phone to that terminal.
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
 * Send text input to a Claude Code terminal.
 *
 * If sessionId is provided, tries to find the terminal associated with that
 * session. Otherwise sends to the first Claude Code terminal found.
 *
 * Returns true if input was sent, false if no suitable terminal was found.
 */
export function sendToClaudeTerminal(text: string, _sessionId?: string): boolean {
  const terminals = findClaudeTerminals();

  if (terminals.length === 0) {
    // Fallback: look for any terminal (Claude Code might not set a recognizable name)
    const activeTerminal = vscode.window.activeTerminal;
    if (activeTerminal) {
      activeTerminal.sendText(text);
      return true;
    }
    return false;
  }

  // TODO: When we can map session IDs to specific terminals,
  // use sessionId to find the right one. For now, use the first match.
  const terminal = terminals[0];
  terminal.sendText(text);
  return true;
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
