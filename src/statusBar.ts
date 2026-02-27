/**
 * Status bar indicator for Codedeck Bridge.
 *
 * Shows connection status and phone count in VSCode's status bar.
 * Click to open the pairing QR code.
 */

import * as vscode from 'vscode';

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codedeck.pair';
    this.setOffline();
    this.item.show();
  }

  setOffline(): void {
    this.item.text = '$(broadcast) Codedeck: offline';
    this.item.tooltip = 'Codedeck Bridge - not connected to relays';
    this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  }

  setReady(phoneCount: number): void {
    if (phoneCount === 0) {
      this.item.text = '$(broadcast) Codedeck: no phones';
      this.item.tooltip = 'Codedeck Bridge - connected to relays, no phones paired. Click to pair.';
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    } else {
      this.item.text = `$(broadcast) Codedeck: ${phoneCount} phone${phoneCount > 1 ? 's' : ''}`;
      this.item.tooltip = `Codedeck Bridge - ${phoneCount} phone${phoneCount > 1 ? 's' : ''} connected`;
      this.item.color = undefined; // default color
    }
  }

  setError(message: string): void {
    this.item.text = '$(error) Codedeck: error';
    this.item.tooltip = `Codedeck Bridge - ${message}`;
    this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
  }

  dispose(): void {
    this.item.dispose();
  }
}
