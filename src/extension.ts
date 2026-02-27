/**
 * Codedeck Bridge — VSCode Extension (thin wrapper)
 *
 * This is a thin wrapper around BridgeCore that provides VSCode-specific
 * integrations: FileSystemWatcher, terminal access, status bar, pairing UI,
 * and configuration management.
 *
 * The core logic (Nostr relay, session data, terminal I/O routing) lives in
 * core.ts and can be reused in a standalone daemon without VSCode.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as nip19 from 'nostr-tools/nip19';
import { SessionWatcher } from './sessionWatcher';
import { NostrRelay } from './nostrRelay';
import { BridgeCore } from './core';
import { StatusBar } from './statusBar';
import { sendToClaudeTerminal, notifyNoTerminal } from './terminalBridge';
import {
  showPairingPanel,
  loadPairedPhones,
  savePairedPhones,
  loadSecretKey,
  saveSecretKey,
} from './pairing';
import type { PairedPhone } from './types';

let bridgeCore: BridgeCore | undefined;
let sessionWatcher: SessionWatcher | undefined;
let statusBar: StatusBar | undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log('[Codedeck] Extension activating...');

  // --- Initialize keypair ---
  let secretKey = loadSecretKey(context);
  if (!secretKey) {
    secretKey = NostrRelay.generateSecretKey();
    saveSecretKey(context, secretKey);
    console.log('[Codedeck] Generated new bridge keypair');
  }

  // --- Read configuration ---
  const config = vscode.workspace.getConfiguration('codedeck');
  const relays = config.get<string[]>('relays', ['wss://relay.damus.io', 'wss://nos.lol']);
  const machineName = config.get<string>('machineName', '') || os.hostname();

  // --- Load paired phones ---
  const pairedPhones = loadPairedPhones(context);

  // --- Status bar ---
  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  // --- Core bridge (pure Node.js logic) ---
  bridgeCore = new BridgeCore(
    { secretKey, relays, machineName, pairedPhones },
    { sendText: sendToClaudeTerminal, notifyNoTerminal },
  );

  // --- Session watcher (VSCode FileSystemWatcher) ---
  sessionWatcher = new SessionWatcher({
    onOutput: (sessionId, entries) => {
      bridgeCore?.onSessionOutput(sessionId, entries);
    },
    onSessionListChanged: (sessions) => {
      bridgeCore?.onSessionListChanged(sessions);
    },
  });
  context.subscriptions.push(sessionWatcher);
  sessionWatcher.start();

  // Wire session provider into core for history requests
  bridgeCore.setSessionProvider(sessionWatcher);

  if (pairedPhones.length > 0) {
    bridgeCore.connect();
    statusBar.setReady(pairedPhones.length);
  } else {
    statusBar.setReady(0);
  }

  // --- Register commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('codedeck.pair', () => {
      if (!bridgeCore) { return; }

      showPairingPanel(
        context,
        {
          npub: bridgeCore.relay.npub,
          relays,
          machine: machineName,
        },
        (pubkeyInput: string, label: string) => {
          // Decode npub if needed
          let pubkeyHex: string;
          if (pubkeyInput.startsWith('npub1')) {
            try {
              const decoded = nip19.decode(pubkeyInput);
              if (decoded.type !== 'npub') {
                vscode.window.showErrorMessage('Invalid npub');
                return;
              }
              pubkeyHex = decoded.data as string;
            } catch {
              vscode.window.showErrorMessage('Invalid npub format');
              return;
            }
          } else {
            pubkeyHex = pubkeyInput;
          }

          // Add to paired phones
          const phone: PairedPhone = {
            npub: nip19.npubEncode(pubkeyHex),
            pubkeyHex,
            label,
            pairedAt: new Date().toISOString(),
          };

          const phones = loadPairedPhones(context);
          // Don't add duplicate
          if (phones.some(p => p.pubkeyHex === pubkeyHex)) {
            vscode.window.showInformationMessage(`Phone "${label}" is already paired`);
            return;
          }

          phones.push(phone);
          savePairedPhones(context, phones);

          // Reconnect relay with new phone
          bridgeCore?.relay.updatePairedPhones(phones);
          if (!bridgeCore?.relay.isConnected()) {
            bridgeCore?.connect();
          }
          statusBar?.setReady(phones.length);

          // Send current session list to the new phone
          if (sessionWatcher) {
            bridgeCore?.onSessionListChanged(sessionWatcher.getSessions());
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codedeck.status', () => {
      const phones = loadPairedPhones(context);
      const sessions = sessionWatcher?.getSessions() ?? [];
      const connected = bridgeCore?.relay.isConnected() ?? false;

      const lines = [
        `Machine: ${machineName}`,
        `Bridge npub: ${bridgeCore?.relay.npub ?? 'N/A'}`,
        `Relays: ${relays.join(', ')}`,
        `Connected: ${connected ? 'Yes' : 'No'}`,
        `Paired phones: ${phones.length}`,
        ...phones.map(p => `  - ${p.label} (${p.npub.slice(0, 16)}...)`),
        `Sessions detected: ${sessions.length}`,
        ...sessions.slice(0, 10).map(s => `  - ${s.slug} (${s.cwd})`),
      ];

      vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codedeck.disconnect', () => {
      bridgeCore?.disconnect();
      statusBar?.setOffline();
      vscode.window.showInformationMessage('Codedeck: Disconnected from relays');
    }),
  );

  // --- Watch for config changes ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('codedeck.relays')) {
        const newRelays = vscode.workspace.getConfiguration('codedeck').get<string[]>('relays', ['wss://relay.damus.io', 'wss://nos.lol']);
        bridgeCore?.relay.updateRelays(newRelays);
        console.log('[Codedeck] Relays updated:', newRelays);
      }
    }),
  );

  console.log(`[Codedeck] Extension activated. Machine: ${machineName}, Relays: ${relays.join(', ')}, Phones: ${pairedPhones.length}`);
}

export function deactivate(): void {
  console.log('[Codedeck] Extension deactivating...');
  bridgeCore?.disconnect();
  sessionWatcher?.dispose();
  statusBar?.dispose();
}
