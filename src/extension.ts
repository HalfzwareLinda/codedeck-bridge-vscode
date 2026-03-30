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
import { TerminalRegistry, notifyNoTerminal } from './terminalBridge';
import {
  showPairingPanel,
  loadPairedPhones,
  savePairedPhones,
  loadSecretKey,
  saveSecretKey,
} from './pairing';
import type { PairedPhone, RemoteSessionInfo } from './types';

let bridgeCore: BridgeCore | undefined;
let sessionWatcher: SessionWatcher | undefined;
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

  // --- Terminal registry (session-to-terminal mapping) ---
  const terminalRegistry = new TerminalRegistry();
  context.subscriptions.push(terminalRegistry);

  // Wire expired input notifications to input-failed feedback
  terminalRegistry.onInputExpired = (sessionId: string) => {
    bridgeCore?.relay.publishInputFailed(sessionId, 'expired').catch(err => {
      console.error('[Codedeck] Failed to publish input-failed (expired):', err);
    });
  };

  /** Filter to sessions with a live terminal and enrich with terminal status. */
  const enrichWithTerminalStatus = (sessions: RemoteSessionInfo[]) =>
    sessions
      .filter(s => terminalRegistry.hasTerminal(s.id))
      .map(s => ({ ...s, hasTerminal: true }));

  // --- Core bridge (pure Node.js logic) ---
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const lastSeenTimestamp = context.globalState.get<number>('codedeck_lastSeenTimestamp', 0);
  bridgeCore = new BridgeCore(
    { secretKey, relays, machineName, pairedPhones, workspaceCwd, lastSeenTimestamp },
    {
      sendText: (text, sessionId?) => terminalRegistry.sendText(text, sessionId),
      sendTextDirect: (text, sessionId?) => terminalRegistry.sendTextDirect(text, sessionId),
      sendKeypress: (key, sessionId?) => terminalRegistry.sendKeypress(key, sessionId),
      sendShiftTab: (sessionId) => terminalRegistry.sendShiftTab(sessionId),
      createSession: (sessionId, cwd?) => {
        log(`[Codedeck] Spawning Claude Code terminal with session-id=${sessionId}`);
        terminalRegistry.createSession(sessionId, cwd);
        log(`[Codedeck] Claude Code terminal spawned for ${sessionId}`);
      },
      queueInputForRelaunch: (sessionId, text) => terminalRegistry.queueInputForRelaunch(sessionId, text),
      closeSession: (sessionId) => {
        log(`[Codedeck] Closing terminal for session ${sessionId}`);
        return terminalRegistry.closeSession(sessionId);
      },
      notifyNoTerminal,
    },
    log,
  );

  // Wire connection status to status bar
  bridgeCore.relay.setConnectionCallback((status, message) => {
    switch (status) {
      case 'connected':
        statusBar?.setReady(loadPairedPhones(context).length);
        // Publish current session list so phones see us immediately
        if (sessionWatcher) {
          const sessions = sessionWatcher.getSessions();
          log(`[Codedeck] Relay connected (oneose) — requesting publish of ${sessions.length} sessions`);
          for (const s of sessions) {
            log(`[Codedeck]   session: ${s.slug} (${s.id})`);
          }
          bridgeCore?.onSessionListChanged(enrichWithTerminalStatus(sessions));
        } else {
          log('[Codedeck] Relay connected but sessionWatcher not ready');
        }
        break;
      case 'disconnected':
        statusBar?.setOffline();
        break;
      case 'error':
        statusBar?.setError(message ?? 'Connection error');
        break;
    }
  });

  // --- Tracked auto-approve timers (cancellable by toolUseId) ---
  const pendingAutoApproveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // --- Session watcher (VSCode FileSystemWatcher) ---
  sessionWatcher = new SessionWatcher({
    onOutput: (sessionId, entries) => {
      bridgeCore?.onSessionOutput(sessionId, entries);
    },
    onSessionListChanged: (sessions) => {
      log(`[Codedeck] SessionWatcher fired onSessionListChanged (${sessions.length} sessions)`);
      bridgeCore?.onSessionListChanged(enrichWithTerminalStatus(sessions));
    },
    onNewSession: (sessionId, cwd) => {
      terminalRegistry.onNewSession(sessionId, cwd);
      bridgeCore?.onNewSession(sessionId, cwd);
    },
    onPermissionModeChanged: (sessionId, mode) => {
      bridgeCore?.onPermissionModeObserved(sessionId, mode);
    },
    onAutoApprovePermission: (sessionId, toolUseId, toolName) => {
      log(`[Codedeck] Auto-approving ${toolName} for ${sessionId} (id=${toolUseId})`);
      // Cancel any existing timer for this tool (e.g. from a retry)
      const existing = pendingAutoApproveTimers.get(toolUseId);
      if (existing) clearTimeout(existing);
      // Hold output flush briefly so tool_use + tool_result arrive together on phone
      bridgeCore?.relay.setAutoApproveHoldoff(500);
      // Short delay gives Claude Code time to render the permission prompt
      // after writing tool_use to JSONL — avoids lost keypresses under load.
      const timer = setTimeout(() => {
        pendingAutoApproveTimers.delete(toolUseId);
        terminalRegistry.sendKeypress('1', sessionId);
      }, 50);
      pendingAutoApproveTimers.set(toolUseId, timer);
    },
    onCancelAutoApprove: (toolUseId) => {
      const timer = pendingAutoApproveTimers.get(toolUseId);
      if (timer) {
        clearTimeout(timer);
        pendingAutoApproveTimers.delete(toolUseId);
        log(`[Codedeck] Cancelled pending auto-approve for ${toolUseId}`);
      }
    },
    getTrackedMode: (sessionId) => bridgeCore?.getTrackedMode(sessionId),
  }, workspaceCwd);
  context.subscriptions.push(sessionWatcher);

  // --- Terminal-first wiring ---
  // When a phone-spawned terminal is discovered (slug in name), find its JSONL and start watching
  terminalRegistry.onTerminalDiscovered = (slug, terminal) => {
    log(`[Codedeck] Terminal discovered with slug: ${slug}`);
    const sessionId = sessionWatcher!.findSessionBySlug(slug);
    if (sessionId) {
      log(`[Codedeck] Resolved slug ${slug} → ${sessionId}`);
      terminalRegistry.resolveTerminal(sessionId, terminal);
      sessionWatcher!.watchSession(sessionId);
    } else {
      log(`[Codedeck] No JSONL found for slug ${slug} — terminal will resolve when JSONL appears`);
    }
  };

  // When a mapped terminal closes, stop watching its session
  terminalRegistry.onTerminalClosed = (sessionId) => {
    log(`[Codedeck] Terminal closed for session ${sessionId}`);
    sessionWatcher!.unwatchSession(sessionId);
    const sessions = sessionWatcher!.getSessions();
    bridgeCore?.onSessionListChanged(enrichWithTerminalStatus(sessions));
  };

  // When a new JSONL appears, check if an unresolved terminal matches
  sessionWatcher.shouldAcceptNewFile = (sessionId, cwd) => {
    const unresolved = terminalRegistry.getUnresolvedTerminals();
    if (unresolved.length === 0) { return false; }

    const now = Date.now();
    // Temporal proximity: match terminals opened in the last 30 seconds
    const candidates = unresolved.filter(u => (now - u.openedAt) < 30_000);
    if (candidates.length === 0) { return false; }

    let matched: typeof candidates[0] | null = null;
    if (candidates.length === 1) {
      matched = candidates[0];
    } else {
      // Multiple candidates: match by cwd basename in terminal name
      const cwdBasename = cwd.split('/').pop() || '';
      if (cwdBasename) {
        matched = candidates.find(c => c.terminal.name.includes(cwdBasename)) ?? null;
      }
    }

    if (matched) {
      log(`[Codedeck] Resolved unresolved terminal for session ${sessionId}`);
      terminalRegistry.resolveTerminal(sessionId, matched.terminal);
      return true;
    }
    return false;
  };

  // Start the file watcher (no initial scan — terminals drive session discovery)
  sessionWatcher.start();

  // Scan existing terminals for extension reload recovery
  terminalRegistry.scanExistingTerminals();

  // Wire session provider into core for history requests
  bridgeCore.setSessionProvider(sessionWatcher);

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
        // Decode npub if needed
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
        try {
          await savePairedPhones(context, phones);
        } catch (err) {
          console.error('[Codedeck] Failed to save paired phones:', err);
          vscode.window.showErrorMessage('Codedeck: Failed to save phone pairing');
          return;
        }

        // Reconnect relay with new phone
        bridgeCore?.relay.updatePairedPhones(phones);
        if (!bridgeCore?.relay.isConnected()) {
          statusBar?.setConnecting();
          bridgeCore?.connect();
        }
        statusBar?.setReady(phones.length);

        // Send current session list to the new phone
        if (sessionWatcher) {
          bridgeCore?.onSessionListChanged(enrichWithTerminalStatus(sessionWatcher.getSessions()));
        }
      },
    );
  };

  // --- Register commands ---

  // Quick menu — shown when clicking the status bar
  context.subscriptions.push(
    vscode.commands.registerCommand('codedeck.quickMenu', async () => {
      const phones = loadPairedPhones(context);
      const connected = bridgeCore?.relay.isConnected() ?? false;
      const sessions = sessionWatcher?.getSessions() ?? [];

      const items: vscode.QuickPickItem[] = [];

      // Status summary line
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
      const sessions = sessionWatcher?.getSessions() ?? [];
      const connected = bridgeCore?.relay.isConnected() ?? false;

      const lines = [
        `Machine: ${machineName}`,
        `Bridge npub: ${bridgeCore?.relay.npub ?? 'N/A'}`,
        `Relays: ${relays.join(', ')}`,
        `Connected: ${connected ? 'Yes' : 'No'}`,
        `Paired phones: ${phones.length}`,
        ...phones.map(p => `  - ${p.label} (${p.npub.slice(0, 20)}...)`),
        `Sessions detected: ${sessions.length}`,
        ...sessions.slice(0, 10).map(s => `  - ${s.slug} (${s.cwd})`),
      ];

      // Non-modal: show in output channel instead of blocking dialog
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

  console.log(`[Codedeck] Extension activated. Machine: ${machineName}, Relays: ${relays.join(', ')}, Phones: ${pairedPhones.length}`);
}

export async function deactivate(): Promise<void> {
  console.log('[Codedeck] Extension deactivating...');
  // Persist last-seen timestamp before shutdown
  const ts = bridgeCore?.relay.lastSeenTimestamp;
  if (ts && ts > 0 && extensionContext) {
    await extensionContext.globalState.update('codedeck_lastSeenTimestamp', ts);
  }
  bridgeCore?.relay.dispose();
  sessionWatcher?.dispose();
  statusBar?.dispose();
  extensionContext = undefined;
}
