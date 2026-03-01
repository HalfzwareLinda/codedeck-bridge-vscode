/**
 * Core bridge orchestrator — coordinates session watching, Nostr relay,
 * and terminal bridging. Contains all logic that could run outside VSCode.
 *
 * This module is the extraction boundary: everything here is pure Node.js.
 * The VSCode extension (extension.ts) is a thin wrapper that provides
 * the FileSystemWatcher, terminal access, status bar, and pairing UI.
 *
 * To run as a standalone daemon in the future, replace the VSCode-specific
 * providers (file watcher, terminal sender) with Node.js equivalents
 * (chokidar for file watching, child_process for terminal I/O).
 */

import { NostrRelay, NostrRelayEvents } from './nostrRelay';
import type { OutputEntry, RemoteSessionInfo, PairedPhone } from './types';

export interface BridgeCoreConfig {
  secretKey: Uint8Array;
  relays: string[];
  machineName: string;
  pairedPhones: PairedPhone[];
}

export interface TerminalSender {
  sendText: (text: string, sessionId?: string) => Promise<boolean>;
  createSession: () => Promise<void>;
  notifyNoTerminal: () => void;
}

export interface SessionProvider {
  getSessions: () => RemoteSessionInfo[];
  getHistory: (sessionId: string, afterSeq?: number) => Array<{ seq: number; entry: OutputEntry }>;
  loadFullHistory: (sessionId: string) => Array<{ seq: number; entry: OutputEntry }>;
  getHistoryCount: (sessionId: string) => number;
}

/**
 * Core bridge that wires up Nostr relay ↔ session data ↔ terminal I/O.
 * Does not depend on VSCode APIs.
 */
export class BridgeCore {
  public readonly relay: NostrRelay;
  private terminal: TerminalSender;
  private sessionProvider: SessionProvider | null = null;

  constructor(config: BridgeCoreConfig, terminal: TerminalSender) {
    this.terminal = terminal;

    const relayEvents: NostrRelayEvents = {
      onInput: async (sessionId, text) => {
        console.log(`[Codedeck] Input for session ${sessionId}: ${text.slice(0, 50)}...`);
        const sent = await this.terminal.sendText(text, sessionId);
        if (!sent) {
          this.terminal.notifyNoTerminal();
        }
      },
      onCreateSession: async () => {
        console.log('[Codedeck] Create session request received');
        await this.terminal.createSession();
        // Re-publish session list so the phone sees the new session promptly.
        // SessionWatcher will also trigger onSessionListChanged when it detects
        // the new JSONL file, but this gives faster feedback.
        if (this.sessionProvider) {
          const sessions = this.sessionProvider.getSessions();
          this.relay.publishSessionList(sessions).catch(err => {
            console.error('[Codedeck] Failed to publish session list after create:', err);
          });
        }
      },
      onPermissionResponse: (_sessionId, _requestId, _allow) => {
        console.log(`[Codedeck] Permission response received (not yet implemented)`);
      },
      onModeChange: (_sessionId, _mode) => {
        console.log(`[Codedeck] Mode change received (not yet implemented)`);
      },
      onHistoryRequest: (sessionId, afterSeq, phonePubkey) => {
        console.log(`[Codedeck] History request for ${sessionId} (afterSeq: ${afterSeq})`);
        if (!this.sessionProvider) { return; }

        let entries = this.sessionProvider.getHistory(sessionId, afterSeq);
        if (entries.length === 0 && (afterSeq === undefined || afterSeq === 0)) {
          entries = this.sessionProvider.loadFullHistory(sessionId);
        }

        const totalEntries = this.sessionProvider.getHistoryCount(sessionId);
        console.log(`[Codedeck] Sending ${entries.length} history entries (total: ${totalEntries}) for ${sessionId}`);

        this.relay.publishHistory(phonePubkey, sessionId, entries, totalEntries).catch(err => {
          console.error('[Codedeck] Failed to publish history:', err);
        });
      },
    };

    this.relay = new NostrRelay(
      config.secretKey,
      config.relays,
      config.pairedPhones,
      config.machineName,
      relayEvents,
    );
  }

  /** Set the session data provider (e.g., SessionWatcher). */
  setSessionProvider(provider: SessionProvider): void {
    this.sessionProvider = provider;
  }

  /** Called when new output is detected from session files. */
  onSessionOutput(sessionId: string, entries: Array<{ seq: number; entry: OutputEntry }>): void {
    this.relay.publishOutput(sessionId, entries).catch(err => {
      console.error('[Codedeck] Failed to publish output:', err);
    });
  }

  /** Called when session list changes (new/deleted sessions). */
  onSessionListChanged(sessions: RemoteSessionInfo[]): void {
    this.relay.publishSessionList(sessions).catch(err => {
      console.error('[Codedeck] Failed to publish session list:', err);
    });
  }

  /** Connect to Nostr relays if phones are paired. */
  connect(): void {
    this.relay.connect();
  }

  /** Disconnect from Nostr relays. */
  disconnect(): void {
    this.relay.disconnect();
  }
}
