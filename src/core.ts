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
import * as crypto from 'crypto';
import { NostrRelay, NostrRelayEvents } from './nostrRelay';
import type { OutputEntry, RemoteSessionInfo, PairedPhone, UploadImageBlossomMessage, UploadImageChunkMessage } from './types';
import { decrypt, getConversationKey } from 'nostr-tools/nip44';

export interface BridgeCoreConfig {
  secretKey: Uint8Array;
  relays: string[];
  machineName: string;
  pairedPhones: PairedPhone[];
  workspaceCwd?: string;
  lastSeenTimestamp?: number;
}

export interface TerminalSender {
  sendText: (text: string, sessionId?: string) => Promise<boolean>;
  /** Send a single raw keypress to the terminal (no Escape+Enter wrapping). */
  sendKeypress: (key: string, sessionId?: string) => Promise<boolean>;
  /** Send Shift+Tab to cycle Claude Code's permission mode. */
  sendShiftTab: (sessionId: string) => Promise<boolean>;
  /** Spawn a new Claude Code terminal with a specific session ID. Returns immediately. */
  createSession: (sessionId: string, cwd?: string) => void;
  /** Queue input for a session that was just relaunched (delayed delivery). */
  queueInputForRelaunch: (sessionId: string, text: string) => void;
  notifyNoTerminal: () => void;
}

export interface SessionProvider {
  getSessions: () => RemoteSessionInfo[];
  getHistory: (sessionId: string, afterSeq?: number) => Array<{ seq: number; entry: OutputEntry }>;
  loadFullHistory: (sessionId: string) => Array<{ seq: number; entry: OutputEntry }>;
  getHistoryCount: (sessionId: string) => number;
  rescanSessions?: () => void;
  /** Get the current permission mode for a session (from JSONL parsing). */
  getPermissionMode?: (sessionId: string) => string | undefined;
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
  private secretKey: Uint8Array;
  private imageChunks: Map<string, ImageUploadTracker> = new Map();

  constructor(config: BridgeCoreConfig, terminal: TerminalSender, private log: (msg: string) => void = console.log) {
    this.terminal = terminal;
    this.workspaceCwd = config.workspaceCwd ?? '';
    this.secretKey = config.secretKey;

    const relayEvents: NostrRelayEvents = {
      onInput: async (sessionId, text, phonePubkey) => {
        this.log(`[Codedeck] Input for session ${sessionId}: ${text.slice(0, 50)}...`);
        const sent = await this.terminal.sendText(text, sessionId);
        if (!sent) {
          // Try to auto-relaunch the session's terminal before giving up
          const sessions = this.sessionProvider?.getSessions() ?? [];
          const session = sessions.find(s => s.id === sessionId);
          if (session) {
            this.log(`[Codedeck] No terminal for ${sessionId} — auto-relaunching in ${session.cwd}`);
            try {
              this.terminal.createSession(sessionId, session.cwd);
              // Queue input for delayed delivery (Claude needs ~5s to start)
              this.terminal.queueInputForRelaunch(sessionId, text);
              this.log(`[Codedeck] Input queued for relaunch of ${sessionId}`);
              return;
            } catch (err) {
              this.log(`[Codedeck] Auto-relaunch failed for ${sessionId}: ${err}`);
            }
          }
          // Relaunch failed or no session info — fall back to input-failed
          this.terminal.notifyNoTerminal();
          this.relay.publishInputFailed(sessionId, 'no-terminal').catch(err => {
            console.error('[Codedeck] Failed to publish input-failed:', err);
          });
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
          // Session launched with --permission-mode plan, seed tracked mode to match
          this.trackedModes.set(sessionId, 'plan');
        } catch (err) {
          this.log(`[Codedeck] Terminal spawn failed for ${sessionId}: ${err}`);
          await this.relay.publishSessionFailed(sessionId, 'terminal-failed');
        }
      },
      onPermissionResponse: async (sessionId, _requestId, allow, modifier) => {
        // Claude Code's permission prompt is an Ink SelectInput with numbered options:
        //   1. Yes
        //   2. Yes, allow all edits during this session (shift+tab)
        //   3. No
        // Pressing the number key instantly selects the option.
        let answer: string;
        if (modifier === 'always') {
          answer = '2';
        } else if (modifier === 'never') {
          answer = '3';
        } else {
          answer = allow ? '1' : '3';
        }
        this.log(`[Codedeck] Permission response for session ${sessionId}: ${answer}`);
        const sent = await this.terminal.sendKeypress(answer, sessionId);
        if (!sent) {
          this.log(`[Codedeck] WARNING: Failed to deliver permission ${answer} to terminal for ${sessionId}`);
          this.relay.publishInputFailed(sessionId, 'no-terminal').catch(err => {
            console.error('[Codedeck] Failed to publish input-failed:', err);
          });
        }
      },
      onKeypress: async (sessionId, key) => {
        this.log(`[Codedeck] Keypress for session ${sessionId}: ${key}`);
        const sent = await this.terminal.sendKeypress(key, sessionId);
        if (!sent) {
          this.log(`[Codedeck] WARNING: Failed to deliver keypress '${key}' to terminal for ${sessionId}`);
          this.relay.publishInputFailed(sessionId, 'no-terminal').catch(err => {
            console.error('[Codedeck] Failed to publish input-failed:', err);
          });
        }
      },
      onModeChange: (sessionId, mode) => {
        this.log(`[Codedeck] Mode change for session ${sessionId}: ${mode}`);
        this.applyModeChange(sessionId, mode).catch(err => {
          console.error('[Codedeck] Mode change failed:', err);
        });
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
      onUploadImage: (msg, phonePubkey) => {
        if ('hash' in msg) {
          // Blossom path: download encrypted blob, decrypt, write to disk
          this.handleBlossomImage(msg as UploadImageBlossomMessage, phonePubkey);
        } else {
          // Legacy chunk path
          const chunk = msg as UploadImageChunkMessage;
          this.handleImageChunk(chunk.sessionId, chunk.uploadId, chunk.filename, chunk.mimeType, chunk.base64Data, chunk.text, chunk.chunkIndex, chunk.totalChunks);
        }
      },
    };

    this.relay = new NostrRelay(
      config.secretKey,
      config.relays,
      config.pairedPhones,
      config.machineName,
      relayEvents,
      log,
      config.lastSeenTimestamp,
    );
  }

  /** Set the session data provider (e.g., SessionWatcher). */
  setSessionProvider(provider: SessionProvider): void {
    this.sessionProvider = provider;
  }

  /**
   * Mode cycling via Shift+Tab keypresses.
   * Claude Code cycles: default → acceptEdits → plan (→ bypassPermissions if enabled).
   *
   * Uses optimistic tracking instead of JSONL verification because Claude Code
   * only writes permissionMode to JSONL on user entries (not on mode changes).
   * Passive drift correction via onPermissionModeObserved() catches mismatches
   * when the next JSONL user entry eventually arrives.
   */
  private static readonly MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
  private static readonly SHIFT_TAB_DELAY_MS = 400;

  /** Bridge-side tracked mode per session (authoritative for delta calculation). */
  private trackedModes: Map<string, string> = new Map();
  /** Serialization chain per session — prevents interleaved Shift+Tab sequences. */
  private modeQueue: Map<string, Promise<void>> = new Map();
  /**
   * Called when a JSONL user entry reveals the actual permissionMode.
   * If it contradicts trackedModes, update to the observed value (passive drift correction).
   */
  onPermissionModeObserved(sessionId: string, observedMode: string): void {
    const tracked = this.trackedModes.get(sessionId);
    if (tracked !== undefined && tracked !== observedMode) {
      this.log(`[Codedeck] Mode drift detected for ${sessionId}: tracked=${tracked}, observed=${observedMode} — syncing`);
      this.trackedModes.set(sessionId, observedMode);
    } else if (tracked === undefined) {
      // First observation — seed the tracked state
      this.trackedModes.set(sessionId, observedMode);
    }
  }

  private async applyModeChange(sessionId: string, targetMode: string): Promise<void> {
    // Serialize per session: chain onto existing queue
    const prev = this.modeQueue.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.doModeSwitch(sessionId, targetMode)).catch(err => {
      this.log(`[Codedeck] Mode switch error for ${sessionId}: ${err}`);
    });
    this.modeQueue.set(sessionId, next);
    await next;
  }

  private async doModeSwitch(sessionId: string, targetMode: string): Promise<void> {
    // Seed tracked mode from JSONL if we haven't tracked this session yet
    if (!this.trackedModes.has(sessionId)) {
      const jsonlMode = this.sessionProvider?.getPermissionMode?.(sessionId);
      if (jsonlMode) { this.trackedModes.set(sessionId, jsonlMode); }
    }

    const currentTracked = this.trackedModes.get(sessionId) ?? 'default';
    if (currentTracked === targetMode) {
      this.log(`[Codedeck] Already in ${targetMode} mode for ${sessionId}`);
      return;
    }

    const sent = await this.sendShiftTabs(sessionId, currentTracked, targetMode);
    if (sent) {
      this.trackedModes.set(sessionId, targetMode);
      this.log(`[Codedeck] Mode optimistically tracked as ${targetMode} for ${sessionId}`);
    }
  }

  /** Send the calculated number of Shift+Tab presses to go from fromMode to toMode. */
  private async sendShiftTabs(sessionId: string, fromMode: string, toMode: string): Promise<boolean> {
    const cycle = BridgeCore.MODE_CYCLE;
    const fromIndex = Math.max(0, cycle.indexOf(fromMode));
    const toIndex = cycle.indexOf(toMode);
    const steps = (toIndex - fromIndex + cycle.length) % cycle.length;

    if (steps === 0) { return true; }

    this.log(`[Codedeck] Sending ${steps} Shift+Tab(s) for ${sessionId}: ${fromMode} → ${toMode}`);

    for (let i = 0; i < steps; i++) {
      const sent = await this.terminal.sendShiftTab(sessionId);
      if (!sent) {
        this.log(`[Codedeck] Failed to send Shift+Tab for ${sessionId} (step ${i + 1}/${steps})`);
        return false;
      }
      if (i < steps - 1) {
        await new Promise(resolve => setTimeout(resolve, BridgeCore.SHIFT_TAB_DELAY_MS));
      }
    }
    return true;
  }

  /** Called when new output is detected from session files. */
  onSessionOutput(sessionId: string, entries: Array<{ seq: number; entry: OutputEntry }>): void {
    this.relay.publishOutput(sessionId, entries).catch(err => {
      console.error('[Codedeck] Failed to publish output:', err);
    });
  }

  /** Called when session list changes (new/deleted sessions). */
  onSessionListChanged(sessions: RemoteSessionInfo[]): void {
    // Seed trackedModes for sessions not yet tracked (e.g., after extension reload)
    for (const s of sessions) {
      if (!this.trackedModes.has(s.id)) {
        this.trackedModes.set(s.id, s.permissionMode ?? 'default');
      }
    }

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

  // --- Image upload: Blossom (encrypted blob) ---

  private async handleBlossomImage(msg: UploadImageBlossomMessage, phonePubkey: string): Promise<void> {
    this.log(`[Codedeck] Blossom image: downloading ${msg.url} (${msg.sizeBytes} bytes)`);

    try {
      // 1. Download encrypted blob from Blossom server
      const response = await fetch(msg.url);
      if (!response.ok) {
        throw new Error(`Blossom download failed: ${response.status} ${response.statusText}`);
      }
      const encryptedBytes = new Uint8Array(await response.arrayBuffer());

      // 2. Verify SHA-256 hash
      const hashBuffer = crypto.createHash('sha256').update(encryptedBytes).digest();
      const hashHex = hashBuffer.toString('hex');
      if (hashHex !== msg.hash) {
        throw new Error(`Hash mismatch: expected ${msg.hash}, got ${hashHex}`);
      }

      // 3. NIP-44 decrypt (encrypted string was encoded to bytes for upload)
      const decoder = new TextDecoder();
      const encryptedString = decoder.decode(encryptedBytes);
      const conversationKey = getConversationKey(this.secretKey, phonePubkey);
      const base64Data = decrypt(encryptedString, conversationKey);

      // 4. Write decrypted image to disk
      const uploadsDir = path.join(this.workspaceCwd || '.', '.codedeck', 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      const safeName = msg.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = msg.mimeType === 'image/png' ? '.png' : '.jpg';
      const timestamp = Date.now();
      const hasExt = safeName.toLowerCase().endsWith(ext);
      const finalName = `${timestamp}-${safeName}${hasExt ? '' : ext}`;
      const filePath = path.join(uploadsDir, finalName);

      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(filePath, buffer);
      this.log(`[Codedeck] Blossom image saved: ${filePath} (${buffer.length} bytes)`);

      // 5. Send text to Claude Code terminal referencing the file path
      const userText = msg.text.trim();
      const terminalText = userText
        ? `${userText}\n\n[Attached image: ${filePath} — use the Read tool to view it]`
        : `Please examine this image: ${filePath}`;

      const sent = await this.terminal.sendText(terminalText, msg.sessionId);
      if (!sent) {
        this.terminal.notifyNoTerminal();
      }
    } catch (err) {
      this.log(`[Codedeck] Blossom image download/decrypt failed: ${err}`);
    }
  }

  // --- Image upload chunk assembly (legacy) ---

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
