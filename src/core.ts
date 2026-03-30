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
  /** Send text directly, skipping Escape key (for plan revision prompts). */
  sendTextDirect: (text: string, sessionId?: string) => Promise<boolean>;
  /** Send a single raw keypress to the terminal (no Escape+Enter wrapping). */
  sendKeypress: (key: string, sessionId?: string) => Promise<boolean>;
  /** Send Shift+Tab to cycle Claude Code's permission mode. */
  sendShiftTab: (sessionId: string) => Promise<boolean>;
  /** Spawn a new Claude Code terminal with a specific session ID. Returns immediately. */
  createSession: (sessionId: string, cwd?: string) => void;
  /** Queue input for a session that was just relaunched (delayed delivery). */
  queueInputForRelaunch: (sessionId: string, text: string) => void;
  /** Close (dispose) the terminal for a session. Returns true if found and closed. */
  closeSession: (sessionId: string) => boolean;
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
  /** Check if a tool_use_id already has a matching tool_result. */
  isToolResolved?: (sessionId: string, toolUseId: string) => boolean;
  /** Register a session for watching (triggers pending watch if JSONL doesn't exist yet). */
  watchSession?: (sessionId: string, cwd?: string) => void;
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
        const isRevision = this.pendingRevisionSessions.delete(sessionId);
        this.log(`[Codedeck] Input for session ${sessionId}${isRevision ? ' (revision)' : ''}: ${text.slice(0, 50)}...`);

        // Plan revision text goes directly (no Escape key) since Escape cancels the revision prompt
        const sent = isRevision
          ? await this.terminal.sendTextDirect(text, sessionId)
          : await this.terminal.sendText(text, sessionId);
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

          // Register pending watch so sessionWatcher picks up the JSONL as soon as it appears
          this.sessionProvider?.watchSession?.(sessionId, this.workspaceCwd || undefined);

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
      onPermissionResponse: async (sessionId, requestId, allow, modifier) => {
        // Guard: if the tool already resolved (e.g. terminal advanced past the prompt
        // before the phone user tapped Allow), skip the keypress to avoid phantom input.
        if (requestId && this.sessionProvider?.isToolResolved?.(sessionId, requestId)) {
          this.log(`[Codedeck] Permission response for ${sessionId} skipped — tool ${requestId} already resolved`);
          return;
        }
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

        // Update tracked mode based on plan approval choices.
        // Claude Code exits plan mode immediately on approval, but the JSONL
        // permissionMode field only appears on the next user entry. Without
        // preemptive tracking, subsequent mode switches calculate wrong Shift+Tab deltas.
        let planApprovalMode: string | undefined;

        if (this.trackedModes.get(sessionId) === 'plan') {
          switch (key) {
            case '1': {
              // Clear context & auto-accept → new session spawns with acceptEdits
              this.trackedModes.set(sessionId, 'acceptEdits');
              planApprovalMode = 'acceptEdits';
              const sessions = this.sessionProvider?.getSessions() ?? [];
              const session = sessions.find(s => s.id === sessionId);
              const cwd = session?.cwd || this.workspaceCwd;
              this.pendingReplacements.set(sessionId, { cwd, timestamp: Date.now() });
              this.log(`[Codedeck] Plan option 1 detected — tracking ${sessionId} for replacement`);
              break;
            }
            case '2':
              // Approve (auto-accept edits)
              this.trackedModes.set(sessionId, 'acceptEdits');
              planApprovalMode = 'acceptEdits';
              this.log(`[Codedeck] Plan option 2 — tracked mode → acceptEdits for ${sessionId}`);
              break;
            case '3':
              // Approve (manual edits)
              this.trackedModes.set(sessionId, 'default');
              planApprovalMode = 'default';
              this.log(`[Codedeck] Plan option 3 — tracked mode → default for ${sessionId}`);
              break;
            case '4':
              // Revise plan — stays in plan mode, next input is a revision (skip Escape)
              this.pendingRevisionSessions.add(sessionId);
              this.log(`[Codedeck] Plan option 4 — next input for ${sessionId} is a revision`);
              break;
          }
        }

        // After plan approval (keys 1-3), Claude Code needs time to process
        // the keypress and transition modes. Chain a settle delay into
        // modeQueue so any subsequent doModeSwitch waits before sending
        // Shift+Tabs — prevents desync when user switches mode immediately.
        if (key >= '1' && key <= '3') {
          const prev = this.modeQueue.get(sessionId) ?? Promise.resolve();
          this.modeQueue.set(sessionId, prev.then(() =>
            new Promise<void>(resolve => setTimeout(resolve, BridgeCore.KEYPRESS_SETTLE_MS))
          ));
        }

        const sent = await this.terminal.sendKeypress(key, sessionId);
        if (!sent) {
          this.log(`[Codedeck] WARNING: Failed to deliver keypress '${key}' to terminal for ${sessionId}`);
          this.relay.publishInputFailed(sessionId, 'no-terminal').catch(err => {
            console.error('[Codedeck] Failed to publish input-failed:', err);
          });
        }

        // Publish mode-confirmed after successful plan approval delivery
        if (sent && planApprovalMode !== undefined) {
          this.relay.publishModeConfirmed(sessionId, planApprovalMode).catch(err => {
            this.log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
          });
        }
      },
      onModeChange: (sessionId, mode) => {
        this.log(`[Codedeck] Mode change for session ${sessionId}: ${mode}`);
        // Debounce per session — collapses rapid-fire mode requests into one
        const pending = this.modeDebounce.get(sessionId);
        if (pending) { clearTimeout(pending); }
        this.modeDebounce.set(sessionId, setTimeout(() => {
          this.modeDebounce.delete(sessionId);
          // Legacy: old phone APKs may still send 'bypassPermissions' — treat as 'default'
          const terminalMode = mode === 'bypassPermissions' ? 'default' : mode;
          this.applyModeChange(sessionId, terminalMode).catch(err => {
            console.error('[Codedeck] Mode change failed:', err);
          });
        }, 300));
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
        // Terminal-first: just re-emit the current active session list
        const sessions = this.sessionProvider.getSessions();
        this.log(`[Codedeck] Re-publishing ${sessions.length} sessions`);
        this.onSessionListChanged(sessions);
      },
      onCloseSession: async (sessionId) => {
        this.log(`[Codedeck] Close session request for ${sessionId}`);
        this.trackedModes.delete(sessionId);
        this.modeQueue.delete(sessionId);
        this.pendingModeVerification.delete(sessionId);
        this.pendingRetryCount.delete(sessionId);
        const found = this.terminal.closeSession(sessionId);
        // Re-publish session list excluding the closed session
        const sessions = (this.sessionProvider?.getSessions() ?? [])
          .filter(s => s.id !== sessionId);
        this.onSessionListChanged(sessions);
        // Send ack so the phone knows whether the terminal was actually closed
        this.relay.publishCloseSessionAck(sessionId, found).catch(err => {
          console.error('[Codedeck] Failed to publish close-session-ack:', err);
        });
      },
      onUploadImage: (msg, phonePubkey) => {
        if ('hash' in msg) {
          // Blossom path: download encrypted blob, decrypt, write to disk
          this.handleBlossomImage(msg as UploadImageBlossomMessage);
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
   * Claude Code's actual Shift+Tab cycle: plan → default → acceptEdits (3 modes).
   * Phone cycle matches: PLAN → YOLO (default) → EDITS.
   *
   * In 'default' mode the bridge auto-approves all permission prompts (YOLO).
   *
   * Uses optimistic tracking instead of JSONL verification because Claude Code
   * only writes permissionMode to JSONL on user entries (not on mode changes).
   * Passive drift correction via onPermissionModeObserved() catches mismatches
   * when the next JSONL user entry eventually arrives.
   */
  private static readonly MODE_CYCLE = ['plan', 'default', 'acceptEdits'];
  private static readonly SHIFT_TAB_DELAY_MS = 400;
  /** Delay after plan approval keypress before allowing Shift+Tab sequences. */
  private static readonly KEYPRESS_SETTLE_MS = 600;

  /** Sessions expecting a revision input (keypress '4' was sent). Next input skips Escape. */
  private pendingRevisionSessions: Set<string> = new Set();
  /** Bridge-side tracked mode per session (authoritative for delta calculation). */
  private trackedModes: Map<string, string> = new Map();
  /** Serialization chain per session — prevents interleaved Shift+Tab sequences. */
  private modeQueue: Map<string, Promise<void>> = new Map();
  /** Per-session debounce timer for incoming mode changes (collapses rapid-fire requests). */
  private modeDebounce: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Per-session AbortController to cancel in-flight Shift+Tab sequences. */
  private modeAbort: Map<string, AbortController> = new Map();
  /** Sessions expecting a replacement after plan option 1 ("clear context & auto-accept"). */
  private pendingReplacements: Map<string, { cwd: string; timestamp: number }> = new Map();
  /** Pending mode verification: after an optimistic update, stores what we expect confirmed by JSONL. */
  private pendingModeVerification: Map<string, { expectedMode: string; timestamp: number; retryCount: number }> = new Map();
  /** Retry count carried across applyModeChange calls for verification retries. */
  private pendingRetryCount: Map<string, number> = new Map();
  private static readonly MODE_VERIFY_WINDOW_MS = 10_000;
  private static readonly MODE_VERIFY_MAX_RETRIES = 2;

  /** Get the bridge's authoritative tracked mode for a session. */
  getTrackedMode(sessionId: string): string | undefined {
    return this.trackedModes.get(sessionId);
  }

  /**
   * Called when a JSONL user entry reveals the actual permissionMode.
   * If it contradicts trackedModes, update to the observed value (passive drift correction).
   * Also performs event-driven verification of pending mode switches.
   */
  onPermissionModeObserved(sessionId: string, observedMode: string): void {
    const tracked = this.trackedModes.get(sessionId);
    if (tracked !== undefined && tracked !== observedMode) {
      this.log(`[Codedeck] Mode drift detected for ${sessionId}: tracked=${tracked}, observed=${observedMode} — syncing`);
      this.trackedModes.set(sessionId, observedMode);
      // Passive correction only — the next natural session list publish will
      // include the corrected mode. Eagerly re-publishing here caused a
      // feedback loop with phone-side mode reconciliation (issue: session duplication).
    } else if (tracked === undefined) {
      // First observation — seed the tracked state
      this.trackedModes.set(sessionId, observedMode);
    }

    // Event-driven verification: check if a pending mode switch needs correction
    const pending = this.pendingModeVerification.get(sessionId);
    if (!pending) { return; }

    if (Date.now() - pending.timestamp > BridgeCore.MODE_VERIFY_WINDOW_MS) {
      this.pendingModeVerification.delete(sessionId);
      return;
    }

    if (observedMode === pending.expectedMode) {
      this.pendingModeVerification.delete(sessionId);
      return; // verified OK
    }

    this.pendingModeVerification.delete(sessionId);
    if (pending.retryCount >= BridgeCore.MODE_VERIFY_MAX_RETRIES) {
      this.log(`[Codedeck] Mode verification for ${sessionId}: max retries (${pending.retryCount}) reached, accepting observed=${observedMode}`);
      return;
    }

    this.log(`[Codedeck] Mode verification FAILED for ${sessionId}: expected=${pending.expectedMode}, observed=${observedMode} — retry ${pending.retryCount + 1}`);
    // trackedModes already corrected by drift detection above.
    this.pendingRetryCount.set(sessionId, pending.retryCount + 1);
    this.applyModeChange(sessionId, pending.expectedMode).catch(err => {
      this.log(`[Codedeck] Mode correction retry failed for ${sessionId}: ${err}`);
    });
  }

  private async applyModeChange(sessionId: string, targetMode: string): Promise<void> {
    // Abort any in-flight mode switch for this session
    this.modeAbort.get(sessionId)?.abort();
    const ac = new AbortController();
    this.modeAbort.set(sessionId, ac);

    // Serialize per session: chain onto existing queue
    const prev = this.modeQueue.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => {
      if (ac.signal.aborted) { return; }
      return this.doModeSwitch(sessionId, targetMode, ac.signal);
    }).catch(err => {
      this.log(`[Codedeck] Mode switch error for ${sessionId}: ${err}`);
    });
    this.modeQueue.set(sessionId, next);
    await next;
  }

  private async doModeSwitch(sessionId: string, targetMode: string, signal?: AbortSignal): Promise<void> {
    // Seed tracked mode from JSONL if we haven't tracked this session yet
    if (!this.trackedModes.has(sessionId)) {
      const jsonlMode = this.sessionProvider?.getPermissionMode?.(sessionId);
      if (jsonlMode) {
        this.trackedModes.set(sessionId, jsonlMode);
      }
    }

    const currentTracked = this.trackedModes.get(sessionId) ?? 'default';
    if (currentTracked === targetMode) {
      this.log(`[Codedeck] Already in ${targetMode} mode for ${sessionId}`);
      // Still confirm to the phone — it may be out of sync and sent this request to re-synchronize.
      this.relay.publishModeConfirmed(sessionId, targetMode).catch(err => {
        this.log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
      });
      return;
    }

    if (signal?.aborted) { return; }
    const result = await this.sendShiftTabs(sessionId, currentTracked, targetMode, signal);

    if (result === 'sent') {
      this.trackedModes.set(sessionId, targetMode);
      this.log(`[Codedeck] Mode optimistically tracked as ${targetMode} for ${sessionId}`);

      // Publish mode-confirmed so the phone can override its optimistic state.
      this.relay.publishModeConfirmed(sessionId, targetMode).catch(err => {
        this.log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
      });

      // Register event-driven verification: onPermissionModeObserved will check
      // whether JSONL confirms this mode change and retry if not (max 2 attempts).
      const retryCount = this.pendingRetryCount.get(sessionId) ?? 0;
      this.pendingRetryCount.delete(sessionId);
      this.pendingModeVerification.set(sessionId, {
        expectedMode: targetMode,
        timestamp: Date.now(),
        retryCount,
      });
    } else if (result === 'failed') {
      // Terminal gone or Shift+Tab delivery failed. Tell the phone where we actually are
      // so it can revert its optimistic state. Verification timer handles partial-delivery drift.
      this.log(`[Codedeck] Mode switch failed for ${sessionId} — confirming current: ${currentTracked}`);
      this.relay.publishModeConfirmed(sessionId, currentTracked).catch(err => {
        this.log(`[Codedeck] Failed to publish mode-confirmed (failure): ${err}`);
      });
    }
    // 'aborted' → do nothing. The superseding request will publish its own confirmation.
  }

  /** Send the calculated number of Shift+Tab presses to go from fromMode to toMode. */
  private async sendShiftTabs(sessionId: string, fromMode: string, toMode: string, signal?: AbortSignal): Promise<'sent' | 'failed' | 'aborted'> {
    const cycle = BridgeCore.MODE_CYCLE;
    const fromIndex = Math.max(0, cycle.indexOf(fromMode));
    const toIndex = cycle.indexOf(toMode);
    const steps = (toIndex - fromIndex + cycle.length) % cycle.length;

    if (steps === 0) { return 'sent'; }

    this.log(`[Codedeck] Sending ${steps} Shift+Tab(s) for ${sessionId}: ${fromMode} → ${toMode}`);

    for (let i = 0; i < steps; i++) {
      if (signal?.aborted) {
        this.log(`[Codedeck] Mode switch aborted for ${sessionId} at step ${i + 1}/${steps}`);
        return 'aborted';
      }
      const sent = await this.terminal.sendShiftTab(sessionId);
      if (!sent) {
        this.log(`[Codedeck] Failed to send Shift+Tab for ${sessionId} (step ${i + 1}/${steps})`);
        return 'failed';
      }
      if (i < steps - 1) {
        await new Promise(resolve => setTimeout(resolve, BridgeCore.SHIFT_TAB_DELAY_MS));
      }
    }
    return 'sent';
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

    // Check if this new session replaces one that was cleared via plan option 1.
    // Match by cwd and recency (within 15 seconds).
    const now = Date.now();
    for (const [oldSessionId, replacement] of this.pendingReplacements) {
      if (now - replacement.timestamp > 15_000) {
        this.pendingReplacements.delete(oldSessionId);
        continue;
      }
      if (_cwd === replacement.cwd || _cwd.startsWith(replacement.cwd)) {
        this.pendingReplacements.delete(oldSessionId);
        const newSession = sessions.find(s => s.id === sessionId);
        if (newSession) {
          this.log(`[Codedeck] Session replaced: ${oldSessionId} → ${sessionId}`);
          // Transfer bridge state from old to new session
          const oldMode = this.trackedModes.get(oldSessionId);
          if (oldMode) {
            this.trackedModes.set(sessionId, oldMode);
            this.trackedModes.delete(oldSessionId);
          }
          // Notify phones so they can swap the session in their UI
          this.relay.publishSessionReplaced(oldSessionId, newSession).catch(err => {
            console.error('[Codedeck] Failed to publish session-replaced:', err);
          });
        }
        break;
      }
    }
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

  private async handleBlossomImage(msg: UploadImageBlossomMessage): Promise<void> {
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

      // 3. AES-256-GCM decrypt
      const key = Buffer.from(msg.key, 'hex');
      const iv = Buffer.from(msg.iv, 'hex');
      // Web Crypto appends the 16-byte auth tag to the ciphertext
      const authTag = encryptedBytes.slice(-16);
      const ciphertext = encryptedBytes.slice(0, -16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      // 4. Write decrypted image to disk
      const uploadsDir = path.join(this.workspaceCwd || '.', '.codedeck', 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      const safeName = msg.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = msg.mimeType === 'image/png' ? '.png' : '.jpg';
      const timestamp = Date.now();
      const hasExt = safeName.toLowerCase().endsWith(ext);
      const finalName = `${timestamp}-${safeName}${hasExt ? '' : ext}`;
      const filePath = path.join(uploadsDir, finalName);

      fs.writeFileSync(filePath, decrypted);
      this.log(`[Codedeck] Blossom image saved: ${filePath} (${decrypted.length} bytes)`);

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
