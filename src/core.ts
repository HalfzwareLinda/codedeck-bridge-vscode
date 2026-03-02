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
  createSession: (pendingId?: string) => Promise<void>;
  notifyNoTerminal: () => void;
  getPendingId?: (sessionId: string) => string | undefined;
  clearPendingId?: (pendingId: string) => void;
}

export interface SessionProvider {
  getSessions: () => RemoteSessionInfo[];
  getHistory: (sessionId: string, afterSeq?: number) => Array<{ seq: number; entry: OutputEntry }>;
  loadFullHistory: (sessionId: string) => Array<{ seq: number; entry: OutputEntry }>;
  getHistoryCount: (sessionId: string) => number;
  rescanSessions?: () => void;
  getAllSessionIds?: () => string[];
  /** Lightweight scan for new session files not yet indexed. */
  scanForNewFiles?: () => void;
}

/**
 * Core bridge that wires up Nostr relay ↔ session data ↔ terminal I/O.
 * Does not depend on VSCode APIs.
 */
export class BridgeCore {
  public readonly relay: NostrRelay;
  private terminal: TerminalSender;
  private sessionProvider: SessionProvider | null = null;

  /** Non-blocking pending session tracking: pendingId → timeout handle. */
  private pendingSessions: Map<string, { pendingId: string; timeoutHandle: ReturnType<typeof setTimeout> }> = new Map();
  private static readonly PENDING_SESSION_TIMEOUT_MS = 30_000;

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
        const pendingId = crypto.randomUUID();
        this.log(`[Codedeck] Create session request received, pendingId=${pendingId}`);

        try {
          // Await the terminal open (~200ms) — confirms the command succeeded
          await this.terminal.createSession(pendingId);
          this.log(`[Codedeck] Terminal opened for ${pendingId}, publishing session-pending`);

          // Publish session-pending (sub-second, terminal confirmed open)
          await this.relay.publishSessionPending(pendingId);

          // Start 30s timeout → publish session-failed('timeout')
          const timeoutHandle = setTimeout(() => {
            this.log(`[Codedeck] Pending session ${pendingId} timed out after ${BridgeCore.PENDING_SESSION_TIMEOUT_MS / 1000}s`);
            this.pendingSessions.delete(pendingId);
            this.terminal.clearPendingId?.(pendingId);
            this.relay.publishSessionFailed(pendingId, 'timeout').catch(err => {
              this.log(`[Codedeck] Failed to publish session-failed: ${err}`);
            });
          }, BridgeCore.PENDING_SESSION_TIMEOUT_MS);

          this.pendingSessions.set(pendingId, { pendingId, timeoutHandle });

          // Return immediately — no blocking await
        } catch (err) {
          this.log(`[Codedeck] Terminal open failed for ${pendingId}: ${err}`);
          // Publish session-failed immediately
          await this.relay.publishSessionFailed(pendingId, 'terminal-failed');
        }
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
      onRefreshSessions: () => {
        this.log('[Codedeck] Refresh sessions request received');
        if (!this.sessionProvider) { return; }
        // Re-scan files from disk first — picks up changes the watcher missed
        this.sessionProvider.rescanSessions?.();
        const sessions = this.sessionProvider.getSessions();
        this.log(`[Codedeck] Re-publishing ${sessions.length} sessions (after rescan)`);
        this.onSessionListChanged(sessions);
      },
    };

    this.relay = new NostrRelay(
      config.secretKey,
      config.relays,
      config.pairedPhones,
      config.machineName,
      relayEvents,
      log,
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
   * Called by extension.ts when SessionWatcher detects a new session file.
   * If there's a matching pendingId (via terminal identity), publish session-ready
   * and clear the timeout. Otherwise just publish the session list.
   */
  onNewSession(sessionId: string, cwd: string): void {
    // Look up pendingId via terminal identity
    const pendingId = this.terminal.getPendingId?.(sessionId);

    if (pendingId && this.pendingSessions.has(pendingId)) {
      const pending = this.pendingSessions.get(pendingId)!;
      clearTimeout(pending.timeoutHandle);
      this.pendingSessions.delete(pendingId);
      this.terminal.clearPendingId?.(pendingId);

      // Find the real session info
      const sessions = this.sessionProvider?.getSessions() ?? [];
      const session = sessions.find(s => s.id === sessionId);

      if (session) {
        this.log(`[Codedeck] New session ${sessionId} matched pendingId ${pendingId} — publishing session-ready`);
        this.relay.publishSessionReady(pendingId, session).catch(err => {
          this.log(`[Codedeck] Failed to publish session-ready: ${err}`);
        });
      }

      // Also publish the updated session list
      this.onSessionListChanged(sessions);
    } else {
      // No pendingId match — user opened terminal manually, just publish session list
      const sessions = this.sessionProvider?.getSessions() ?? [];
      this.onSessionListChanged(sessions);
    }
  }

  /** Connect to Nostr relays if phones are paired. */
  connect(): void {
    this.relay.connect();
  }

  /** Disconnect from Nostr relays. */
  disconnect(): void {
    // Clean up all pending session timeouts
    for (const [, pending] of this.pendingSessions) {
      clearTimeout(pending.timeoutHandle);
    }
    this.pendingSessions.clear();
    this.relay.disconnect();
  }
}
