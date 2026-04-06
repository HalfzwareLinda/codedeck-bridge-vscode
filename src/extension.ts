/**
 * Codedeck Bridge — VSCode Extension (thin wrapper)
 *
 * This is a thin wrapper around BridgeCore that provides VSCode-specific
 * integrations: output channel, status bar, pairing UI, and configuration.
 *
 * The core logic (Nostr relay, SDK session management) lives in core.ts
 * and sdkSession.ts — no terminal emulation, no JSONL file watching.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as nip19 from 'nostr-tools/nip19';
import { BridgeCore } from './core';
import { NostrRelay } from './nostrRelay';
import { StatusBar } from './statusBar';
import {
  showPairingPanel,
  loadPairedPhones,
  savePairedPhones,
  loadSecretKey,
  saveSecretKey,
} from './pairing';
import type { PairedPhone } from './types';

let bridgeCore: BridgeCore | undefined;
let statusBar: StatusBar | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  console.log('[Codedeck] Extension activating...');

  // --- Initialize keypair ---
  let secretKey = loadSecretKey(context);
  if (!secretKey) {
    secretKey = NostrRelay.generateSecretKey();
    saveSecretKey(context, secretKey).then(
      () => console.log('[Codedeck] Generated new bridge keypair'),
      err => {
        console.error('[Codedeck] Failed to save secret key:', err);
        vscode.window.showWarningMessage('Codedeck: Failed to persist bridge keypair. Pairings may not survive restart.');
      },
    );
  }

  // --- Read configuration ---
  const config = vscode.workspace.getConfiguration('codedeck');
  const relays = config.get<string[]>('relays', ['wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nos.lol']);
  const machineName = config.get<string>('machineName', '') || os.hostname();

  // --- Load paired phones ---
  const pairedPhones = loadPairedPhones(context);

  // --- Output channel for visible logging ---
  const out = vscode.window.createOutputChannel('Codedeck Bridge');
  context.subscriptions.push(out);
  const log = (msg: string) => { console.log(msg); out.appendLine(msg); };

  // --- Status bar ---
  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  // --- Core bridge (pure Node.js logic, SDK-based) ---
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const lastSeenTimestamp = context.globalState.get<number>('codedeck_lastSeenTimestamp', 0);
  bridgeCore = new BridgeCore(
    { secretKey, relays, machineName, pairedPhones, workspaceCwd, lastSeenTimestamp },
    log,
  );

  // Wire connection status to status bar
  bridgeCore.relay.setConnectionCallback((status, message) => {
    switch (status) {
      case 'connected':
        statusBar?.setReady(loadPairedPhones(context).length);
        // Publish current session list so phones see us immediately
        const sessions = bridgeCore?.sdk.getSessions() ?? [];
        log(`[Codedeck] Relay connected — publishing ${sessions.length} sessions`);
        bridgeCore?.relay.publishSessionList(sessions).catch(err => {
          console.error('[Codedeck] Failed to publish session list:', err);
        });
        break;
      case 'disconnected':
        statusBar?.setOffline();
        break;
      case 'error':
        statusBar?.setError(message ?? 'Connection error');
        break;
    }
  });

  if (pairedPhones.length > 0) {
    statusBar.setConnecting();
    bridgeCore.connect();
  } else {
    statusBar.setReady(0);
  }

  // --- Helper: open pairing panel ---
  const openPairingPanel = () => {
    if (!bridgeCore) { return; }

    showPairingPanel(
      context,
      {
        npub: bridgeCore.relay.npub,
        relays,
        machine: machineName,
      },
      async (pubkeyInput: string, label: string) => {
        let pubkeyHex: string;
        if (pubkeyInput.startsWith('npub1')) {
          try {
            const decoded = nip19.decode(pubkeyInput);
            if (decoded.type !== 'npub') {
              vscode.window.showErrorMessage('Invalid format. Enter an npub (npub1...) or 64-character hex key.');
              return;
            }
            pubkeyHex = decoded.data as string;
          } catch {
            vscode.window.showErrorMessage('Invalid format. Enter an npub (npub1...) or 64-character hex key.');
            return;
          }
        } else {
          pubkeyHex = pubkeyInput;
        }

        const phone: PairedPhone = {
          npub: nip19.npubEncode(pubkeyHex),
          pubkeyHex,
          label,
          pairedAt: new Date().toISOString(),
        };

        const phones = loadPairedPhones(context);
        if (phones.some(p => p.pubkeyHex === pubkeyHex)) {
          vscode.window.showInformationMessage(`Phone "${label}" is already paired`);
          return;
        }

        phones.push(phone);
        try {
          await savePairedPhones(context, phones);
        } catch (err) {
          console.error('[Codedeck] Failed to save paired phones:', err);
          vscode.window.showErrorMessage('Codedeck: Failed to save phone pairing');
          return;
        }

        bridgeCore?.relay.updatePairedPhones(phones);
        if (!bridgeCore?.relay.isConnected()) {
          statusBar?.setConnecting();
          bridgeCore?.connect();
        }
        statusBar?.setReady(phones.length);

        // Send current session list to the new phone
        const sessions = bridgeCore?.sdk.getSessions() ?? [];
        bridgeCore?.relay.publishSessionList(sessions).catch(err => {
          console.error('[Codedeck] Failed to publish session list:', err);
        });
      },
    );
  };

  // --- Register commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('codedeck.quickMenu', async () => {
      const phones = loadPairedPhones(context);
      const connected = bridgeCore?.relay.isConnected() ?? false;
      const sessions = bridgeCore?.sdk.getSessions() ?? [];

      const items: vscode.QuickPickItem[] = [];

      items.push({
        label: `$(info) ${machineName}`,
        description: connected
          ? `${phones.length} phone${phones.length !== 1 ? 's' : ''} · ${sessions.length} session${sessions.length !== 1 ? 's' : ''}`
          : 'Not connected',
        kind: vscode.QuickPickItemKind.Default,
      });

      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

      items.push({
        label: '$(add) Pair new phone',
        description: 'Show QR code for phone pairing',
      });

      items.push({
        label: '$(output) Show logs',
        description: 'Open the Codedeck Bridge output channel',
      });

      if (phones.length > 0) {
        items.push({
          label: '$(close-all) Disconnect all phones',
          description: `Unpair ${phones.length} phone${phones.length !== 1 ? 's' : ''}`,
        });
      }

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Codedeck Bridge',
      });

      if (!pick) return;

      if (pick.label.includes('Pair new phone')) {
        openPairingPanel();
      } else if (pick.label.includes('Show logs')) {
        out.show(true);
      } else if (pick.label.includes('Disconnect all')) {
        bridgeCore?.disconnect();
        await savePairedPhones(context, []);
        bridgeCore?.relay.updatePairedPhones([]);
        statusBar?.setReady(0);
        vscode.window.showInformationMessage('Codedeck: Disconnected and unpaired all phones');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codedeck.pair', () => {
      openPairingPanel();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codedeck.status', () => {
      const phones = loadPairedPhones(context);
      const sessions = bridgeCore?.sdk.getSessions() ?? [];
      const connected = bridgeCore?.relay.isConnected() ?? false;

      const lines = [
        `Machine: ${machineName}`,
        `Bridge npub: ${bridgeCore?.relay.npub ?? 'N/A'}`,
        `Relays: ${relays.join(', ')}`,
        `Connected: ${connected ? 'Yes' : 'No'}`,
        `Paired phones: ${phones.length}`,
        ...phones.map(p => `  - ${p.label} (${p.npub.slice(0, 20)}...)`),
        `Sessions: ${sessions.length}`,
        ...sessions.slice(0, 10).map(s => `  - ${s.slug} (${s.cwd})`),
      ];

      out.clear();
      out.appendLine('=== Codedeck Bridge Status ===');
      lines.forEach(l => out.appendLine(l));
      out.show(true);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codedeck.disconnect', async () => {
      bridgeCore?.disconnect();
      await savePairedPhones(context, []);
      bridgeCore?.relay.updatePairedPhones([]);
      statusBar?.setReady(0);
      vscode.window.showInformationMessage('Codedeck: Disconnected and unpaired all phones');
    }),
  );

  // --- Watch for config changes ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('codedeck.relays')) {
        const newRelays = vscode.workspace.getConfiguration('codedeck').get<string[]>('relays', ['wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nos.lol']);
        statusBar?.setConnecting();
        bridgeCore?.relay.updateRelays(newRelays);
        console.log('[Codedeck] Relays updated:', newRelays);
      }
    }),
  );

  // --- Persist last-seen timestamp periodically (crash recovery) ---
  const timestampInterval = setInterval(() => {
    const ts = bridgeCore?.relay.lastSeenTimestamp;
    if (ts && ts > 0) {
      context.globalState.update('codedeck_lastSeenTimestamp', ts);
    }
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(timestampInterval) });

  // --- Heartbeat: re-publish session list every 60s so phones detect staleness ---
  const heartbeatInterval = setInterval(() => {
    if (bridgeCore?.relay.isConnected()) {
      const sessions = bridgeCore?.sdk.getSessions() ?? [];
      bridgeCore.relay.publishSessionList(sessions).catch(err => {
        console.error('[Codedeck] Heartbeat publish failed:', err);
      });
    }
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeatInterval) });

  console.log(`[Codedeck] Extension activated. Machine: ${machineName}, Relays: ${relays.join(', ')}, Phones: ${pairedPhones.length}`);
}

export async function deactivate(): Promise<void> {
  console.log('[Codedeck] Extension deactivating...');
  const ts = bridgeCore?.relay.lastSeenTimestamp;
  if (ts && ts > 0 && extensionContext) {
    await extensionContext.globalState.update('codedeck_lastSeenTimestamp', ts);
  }
  // Signal phones that bridge is going offline
  if (bridgeCore?.relay.isConnected()) {
    try {
      await bridgeCore.relay.publishSessionList([]);
    } catch {
      // Best-effort on shutdown
    }
  }

  bridgeCore?.dispose();
  statusBar?.dispose();
  extensionContext = undefined;
}
