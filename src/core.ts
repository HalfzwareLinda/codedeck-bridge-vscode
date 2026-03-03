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

import * as fs from 'fs';
import * as path from 'path';
import { NostrRelay, NostrRelayEvents } from './nostrRelay';
import type { OutputEntry, RemoteSessionInfo, PairedPhone } from './types';

export interface BridgeCoreConfig {
  secretKey: Uint8Array;
  relays: string[];
  machineName: string;
  pairedPhones: PairedPhone[];
  workspaceCwd?: string;
}

export interface TerminalSender {
  sendText: (text: string, sessionId?: string) => Promise<boolean>;
  /** Send a single raw keypress to the terminal (no Escape+Enter wrapping). */
  sendKeypress: (key: string, sessionId?: string) => Promise<boolean>;
  /** Spawn a new Claude Code terminal with a specific session ID. Returns immediately. */
  createSession: (sessionId: string, cwd?: string) => void;
  notifyNoTerminal: () => void;
}

export interface SessionProvider {
  getSessions: () => RemoteSessionInfo[];
  getHistory: (sessionId: string, afterSeq?: number) => Array<{ seq: number; entry: OutputEntry }>;
  loadFullHistory: (sessionId: string) => Array<{ seq: number; entry: OutputEntry }>;
  getHistoryCount: (sessionId: string) => number;
  rescanSessions?: () => void;
}

/**
 * Core bridge that wires up Nostr relay ↔ session data ↔ terminal I/O.
 * Does not depend on VSCode APIs.
 */
interface ImageUploadTracker {
  sessionId: string;
  filename: string;
  mimeType: string;
  text: string;
  totalChunks: number;
  received: Map<number, string>;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class BridgeCore {
  private static readonly IMAGE_ASSEMBLY_TIMEOUT_MS = 60_000;

  public readonly relay: NostrRelay;
  private terminal: TerminalSender;
  private sessionProvider: SessionProvider | null = null;
  private workspaceCwd: string;
  private imageChunks: Map<string, ImageUploadTracker> = new Map();

  constructor(config: BridgeCoreConfig, terminal: TerminalSender, private log: (msg: string) => void = console.log) {
    this.terminal = terminal;
    this.workspaceCwd = config.workspaceCwd ?? '';

    const relayEvents: NostrRelayEvents = {
      onInput: async (sessionId, text) => {
        this.log(`[Codedeck] Input for session ${sessionId}: ${text.slice(0, 50)}...`);
        const sent = await this.terminal.sendText(text, sessionId);
        if (!sent) {
          this.terminal.notifyNoTerminal();
        }
      },
      onCreateSession: async () => {
        const sessionId = crypto.randomUUID();
        this.log(`[Codedeck] Create session request received — spawning claude --session-id ${sessionId}`);

        try {
          // Direct spawn: deterministic sessionId, immediate terminal mapping
          this.terminal.createSession(sessionId, this.workspaceCwd || undefined);

          // Publish session-pending so the phone creates a placeholder
          // (phone expects pending → ready sequence for its UI)
          await this.relay.publishSessionPending(sessionId);

          // Wait for the phone to process the pending placeholder and for relays
          // to cool down (rate-limiting causes session-ready to be dropped otherwise)
          await new Promise(resolve => setTimeout(resolve, 1_000));

          // Build session info from workspace path
          const cwd = this.workspaceCwd || 'workspace';
          const project = cwd.split('/').pop() || cwd;
          const session: RemoteSessionInfo = {
            id: sessionId,
            cwd,
            slug: `session-${sessionId.slice(0, 8)}`,
            lastActivity: new Date().toISOString(),
            lineCount: 0,
            title: null,
            project,
          };

          // Publish session-ready (retries with backoff if rate-limited)
          this.log(`[Codedeck] Publishing session-ready for ${sessionId}`);
          const success = await this.relay.publishSessionReady(sessionId, session);
          if (!success) {
            this.log(`[Codedeck] WARNING: session-ready for ${sessionId} failed on all relays after retries`);
          }
        } catch (err) {
          this.log(`[Codedeck] Terminal spawn failed for ${sessionId}: ${err}`);
          await this.relay.publishSessionFailed(sessionId, 'terminal-failed');
        }
      },
      onPermissionResponse: async (sessionId, _requestId, allow, modifier) => {
        // Map to Claude Code's permission prompt keys:
        // y = yes, n = no, a = always allow, d = don't ask again
        let answer: string;
        if (modifier === 'always') {
          answer = 'a';
        } else if (modifier === 'never') {
          answer = 'd';
        } else {
          answer = allow ? 'y' : 'n';
        }
        this.log(`[Codedeck] Permission response for session ${sessionId}: ${answer}`);
        const sent = await this.terminal.sendKeypress(answer, sessionId);
        if (!sent) {
          this.log(`[Codedeck] WARNING: Failed to deliver permission ${answer} to terminal for ${sessionId}`);
        }
      },
      onKeypress: async (sessionId, key) => {
        this.log(`[Codedeck] Keypress for session ${sessionId}: ${key}`);
        const sent = await this.terminal.sendKeypress(key, sessionId);
        if (!sent) {
          this.log(`[Codedeck] WARNING: Failed to deliver keypress '${key}' to terminal for ${sessionId}`);
        }
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
      onUploadImage: (sessionId, uploadId, filename, mimeType, base64Data, text, chunkIndex, totalChunks) => {
        this.handleImageChunk(sessionId, uploadId, filename, mimeType, base64Data, text, chunkIndex, totalChunks);
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
   * For phone-spawned sessions, session-ready was already published at spawn time.
   * This just publishes the updated session list so phones see the new entry.
   */
  onNewSession(sessionId: string, _cwd: string): void {
    const sessions = this.sessionProvider?.getSessions() ?? [];
    this.onSessionListChanged(sessions);
  }

  /** Connect to Nostr relays if phones are paired. */
  connect(): void {
    this.relay.connect();
  }

  /** Disconnect from Nostr relays. */
  disconnect(): void {
    this.relay.disconnect();
  }

  // --- Image upload chunk assembly ---

  private handleImageChunk(
    sessionId: string, uploadId: string, filename: string, mimeType: string,
    base64Data: string, text: string, chunkIndex: number, totalChunks: number,
  ): void {
    let tracker = this.imageChunks.get(uploadId);

    if (!tracker) {
      const timeoutId = setTimeout(() => {
        const t = this.imageChunks.get(uploadId);
        this.log(`[Codedeck] Image upload ${uploadId} timed out (received ${t?.received.size ?? 0}/${totalChunks} chunks)`);
        this.imageChunks.delete(uploadId);
      }, BridgeCore.IMAGE_ASSEMBLY_TIMEOUT_MS);

      tracker = { sessionId, filename, mimeType, text, totalChunks, received: new Map(), timeoutId };
      this.imageChunks.set(uploadId, tracker);
    }

    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
      this.log(`[Codedeck] Image chunk ${chunkIndex} out of range [0, ${totalChunks}) for upload ${uploadId} — skipping`);
      return;
    }
    tracker.received.set(chunkIndex, base64Data);
    if (chunkIndex === 0 && text) {
      tracker.text = text;
    }

    this.log(`[Codedeck] Image chunk ${chunkIndex + 1}/${totalChunks} for upload ${uploadId}`);

    if (tracker.received.size >= totalChunks) {
      clearTimeout(tracker.timeoutId);
      this.imageChunks.delete(uploadId);
      this.assembleAndWriteImage(tracker);
    }
  }

  private async assembleAndWriteImage(tracker: ImageUploadTracker): Promise<void> {
    // Reassemble base64 in chunk order
    const parts: string[] = [];
    for (let i = 0; i < tracker.totalChunks; i++) {
      const chunk = tracker.received.get(i);
      if (chunk === undefined) {
        this.log(`[Codedeck] Missing chunk ${i} for image upload — aborting`);
        return;
      }
      parts.push(chunk);
    }
    const fullBase64 = parts.join('');

    // Write to .codedeck/uploads/ in workspace
    const uploadsDir = path.join(this.workspaceCwd || '.', '.codedeck', 'uploads');
    try {
      fs.mkdirSync(uploadsDir, { recursive: true });
    } catch (err) {
      this.log(`[Codedeck] Failed to create uploads dir: ${err}`);
      return;
    }

    const safeName = tracker.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = tracker.mimeType === 'image/png' ? '.png' : '.jpg';
    const timestamp = Date.now();
    const hasExt = safeName.toLowerCase().endsWith(ext);
    const finalName = `${timestamp}-${safeName}${hasExt ? '' : ext}`;
    const filePath = path.join(uploadsDir, finalName);

    try {
      const buffer = Buffer.from(fullBase64, 'base64');
      fs.writeFileSync(filePath, buffer);
      this.log(`[Codedeck] Image saved: ${filePath} (${buffer.length} bytes)`);
    } catch (err) {
      this.log(`[Codedeck] Failed to write image: ${err}`);
      return;
    }

    // Send text to Claude Code terminal referencing the file path
    const userText = tracker.text.trim();
    const terminalText = userText
      ? `${userText}\n\n[Attached image: ${filePath} — use the Read tool to view it]`
      : `Please examine this image: ${filePath}`;

    const sent = await this.terminal.sendText(terminalText, tracker.sessionId);
    if (!sent) {
      this.terminal.notifyNoTerminal();
    }
  }
}
