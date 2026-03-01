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
  sendText: (text: string, sessionId?: string, addNewline?: boolean) => Promise<boolean>;
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

  constructor(config: BridgeCoreConfig, terminal: TerminalSender, private log: (msg: string) => void = console.log) {
    this.terminal = terminal;

    const relayEvents: NostrRelayEvents = {
      onInput: async (sessionId, text) => {
        this.log(`[Codedeck] Input for session ${sessionId}: ${text.slice(0, 50)}...`);
        const sent = await this.terminal.sendText(text, sessionId);
        if (!sent) {
          this.terminal.notifyNoTerminal();
        }
      },
      onCreateSession: async () => {
        this.log('[Codedeck] Create session request received');
        const beforeIds = new Set(
          this.sessionProvider?.getSessions().map(s => s.id) ?? []
        );
        await this.terminal.createSession();
        // Don't publish here — the JSONL file doesn't exist yet.
        // Instead, poll until the new session appears and force-publish.
        this.waitForNewSession(beforeIds);
      },
      onPermissionResponse: (_sessionId, _requestId, _allow) => {
        console.log(`[Codedeck] Permission response received (not yet implemented)`);
      },
      onModeChange: (sessionId, mode) => {
        this.log(`[Codedeck] Mode change for session ${sessionId}: ${mode}`);
        if (mode === 'plan') {
          // /plan slash command enters plan mode
          this.terminal.sendText('/plan', sessionId).catch(err => {
            console.error('[Codedeck] Mode change send failed:', err);
          });
        } else {
          // No reliable terminal command to exit plan mode — phone tracks optimistically
          this.log(`[Codedeck] Auto mode for ${sessionId} — tracked on phone only`);
        }
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

  /**
   * Poll for a new session to appear after a create-session request.
   * When found, immediately publish the updated session list so the
   * phone sees it without waiting for SessionWatcher's debounce/poll.
   */
  private waitForNewSession(beforeIds: Set<string>): void {
    const MAX_ATTEMPTS = 15;
    const INTERVAL_MS = 1_000;
    let attempts = 0;

    const check = () => {
      attempts++;
      const sessions = this.sessionProvider?.getSessions() ?? [];
      const newSession = sessions.find(s => !beforeIds.has(s.id));

      if (newSession) {
        this.log(`[Codedeck] New session detected: ${newSession.slug} (${newSession.id}) — force-publishing session list`);
        this.onSessionListChanged(sessions);
        return;
      }

      if (attempts >= MAX_ATTEMPTS) {
        this.log(`[Codedeck] Timed out waiting for new session after ${MAX_ATTEMPTS}s`);
        this.onSessionListChanged(sessions);
        return;
      }

      setTimeout(check, INTERVAL_MS);
    };

    setTimeout(check, INTERVAL_MS);
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
